import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SETTINGS, streamCompletion } from "../../src/sidebarApps/aiCopilot/provider";

function streamingResponse(chunks, status = 200) {
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		}),
		{ status, headers: { "content-type": "text/event-stream" } },
	);
}

describe("AI Copilot streaming provider", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("streams Anthropic text deltas with the expected request headers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			streamingResponse([
				'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
				'data: {"type":"message_stop"}\n\n',
			]),
		);
		vi.stubGlobal("fetch", fetchMock);
		const received = [];

		await streamCompletion(
			{ ...DEFAULT_AI_SETTINGS, apiKey: "test-secret" },
			[{ role: "user", content: "Hi" }],
			(text) => received.push(text),
		);

		expect(received.join("")).toBe("Hello");
		const [url, options] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect(options.headers["x-api-key"]).toBe("test-secret");
		expect(JSON.parse(options.body)).toMatchObject({ stream: true, model: DEFAULT_AI_SETTINGS.model });
	});

	it("joins OpenAI-compatible chunks split across network reads", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			streamingResponse([
				'data: {"choices":[{"delta":{"content":"Good"}}]}\r\n\r',
				'\ndata: {"choices":[{"delta":{"content":" morning"}}]}\n\ndata: [DONE]\n\n',
			]),
		);
		vi.stubGlobal("fetch", fetchMock);
		const received = [];

		await streamCompletion(
			{
				provider: "openai",
				apiKey: "test-secret",
				endpoint: "https://example.test/v1/chat/completions",
				model: "custom-model",
				maxTokens: 512,
			},
			[{ role: "user", content: "Hi" }],
			(text) => received.push(text),
		);

		expect(received.join("")).toBe("Good morning");
		expect(fetchMock.mock.calls[0][0]).toBe("https://example.test/v1/chat/completions");
		expect(fetchMock.mock.calls[0][1].headers.authorization).toBe("Bearer test-secret");
	});

	it("does not expose provider error bodies or credentials", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response("test-secret", { status: 401 }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			streamCompletion(
				{ ...DEFAULT_AI_SETTINGS, apiKey: "test-secret" },
				[{ role: "user", content: "Hi" }],
				() => {},
			),
		).rejects.toThrow("HTTP 401");
	});
});
