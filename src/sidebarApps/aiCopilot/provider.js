export const DEFAULT_AI_SETTINGS = {
	provider: "anthropic",
	apiKey: "",
	endpoint: "https://api.anthropic.com/v1/messages",
	model: "claude-sonnet-4-5",
	maxTokens: 2048,
};

export const AI_SYSTEM_PROMPT =
	"You are Acode AI Copilot. Be concise and technically accurate. When asked to change existing code, first analyze it, explain the proposed changes, then provide the complete replacement in one fenced code block. Never claim that code has been applied. Preserve behavior outside the requested change.";

const DEFAULT_ENDPOINTS = {
	anthropic: DEFAULT_AI_SETTINGS.endpoint,
	openai: "https://api.openai.com/v1/chat/completions",
};

export function defaultEndpoint(provider) {
	return DEFAULT_ENDPOINTS[provider] || DEFAULT_ENDPOINTS.openai;
}

function createRequest(settings, messages) {
	const provider = settings.provider === "openai" ? "openai" : "anthropic";
	const maxTokens = Math.max(
		1,
		Math.min(Number(settings.maxTokens) || 2048, 32768),
	);
	const endpoint = String(
		settings.endpoint || defaultEndpoint(provider),
	).trim();

	if (provider === "anthropic") {
		return {
			url: endpoint,
			headers: {
				"content-type": "application/json",
				"x-api-key": settings.apiKey,
				"anthropic-version": "2023-06-01",
				"anthropic-dangerous-direct-browser-access": "true",
			},
			body: {
				model: settings.model,
				max_tokens: maxTokens,
				stream: true,
				system: AI_SYSTEM_PROMPT,
				messages: messages.map(({ role, content }) => ({ role, content })),
			},
		};
	}

	return {
		url: endpoint,
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${settings.apiKey}`,
		},
		body: {
			model: settings.model,
			max_tokens: maxTokens,
			stream: true,
			messages: [
				{ role: "system", content: AI_SYSTEM_PROMPT },
				...messages.map(({ role, content }) => ({ role, content })),
			],
		},
	};
}

function parseEventData(provider, data, onDelta) {
	if (data === "[DONE]") return true;

	let event;
	try {
		event = JSON.parse(data);
	} catch {
		throw new Error("The provider returned an invalid streaming response.");
	}

	if (event.error) {
		throw new Error(
			"The provider reported an error while generating a response.",
		);
	}

	let text = "";
	if (provider === "anthropic") {
		if (event.type === "error") {
			throw new Error(
				"The provider reported an error while generating a response.",
			);
		}
		if (
			event.type === "content_block_delta" &&
			event.delta?.type === "text_delta"
		) {
			text = event.delta.text || "";
		}
	} else {
		const content = event.choices?.[0]?.delta?.content;
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("");
		}
	}

	if (text) onDelta(text);
	return false;
}

export async function streamCompletion(settings, messages, onDelta, signal) {
	if (!settings.apiKey)
		throw new Error("Add an API key in AI Copilot settings.");
	if (!settings.model?.trim())
		throw new Error("Add a model name in AI Copilot settings.");

	const provider = settings.provider === "openai" ? "openai" : "anthropic";
	const request = createRequest({ ...settings, provider }, messages);
	let response;
	try {
		response = await fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new Error(
			"Could not connect to the AI provider. Check the endpoint and network.",
		);
	}

	if (!response.ok) {
		const statusMessage =
			response.status === 401 || response.status === 403
				? "Check the API key and provider settings."
				: response.status === 429
					? "The provider rate limit was reached. Try again shortly."
					: "Check the endpoint and try again.";
		throw new Error(
			`AI request failed (HTTP ${response.status}). ${statusMessage}`,
		);
	}
	if (!response.body?.getReader) {
		throw new Error("This connection does not support streaming responses.");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let dataLines = [];
	let receivedText = false;
	let streamDone = false;

	const flushEvent = () => {
		if (!dataLines.length) return;
		const isDone = parseEventData(provider, dataLines.join("\n"), (text) => {
			receivedText = true;
			onDelta(text);
		});
		dataLines = [];
		if (isDone) streamDone = true;
	};

	const processLine = (line) => {
		if (!line) {
			flushEvent();
			return;
		}
		if (line.startsWith(":")) return;
		if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
	};

	try {
		while (!streamDone) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
				if (streamDone) break;
			}
		}
		buffer += decoder.decode();
		if (buffer)
			processLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
		flushEvent();
	} catch (error) {
		await reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}

	if (!receivedText) throw new Error("The provider returned no response text.");
}
