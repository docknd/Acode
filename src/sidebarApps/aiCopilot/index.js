import "./style.scss";
import confirm from "dialogs/confirm";
import appSettings from "lib/settings";
import {
	DEFAULT_AI_SETTINGS,
	defaultEndpoint,
	streamCompletion,
} from "./provider";

let container;
let root;
let messagesElement;
let form;
let input;
let sendButton;
let cancelButton;
let contextToggle;
let settingsForm;
let controller = null;
let history = [];

export default ["wand-sparkles", "ai-copilot", "AI Copilot", initApp];

function getSettings() {
	return {
		...DEFAULT_AI_SETTINGS,
		contextEnabled: false,
		...appSettings.value.aiCopilot,
	};
}

function initApp(el) {
	container = el;
	container.classList.add("ai-copilot");
	root = (
		<div className="copilot-root">
			<header className="copilot-header">
				<div className="copilot-heading">
					<strong>AI Copilot</strong>
					<label
						className="context-toggle"
						title="Share the current selection or file with the provider"
					>
						<input type="checkbox" />
						<span>Editor context</span>
					</label>
				</div>
				<details className="copilot-settings">
					<summary title="AI provider settings">
						<span className="icon settings"></span>
						<span>Provider settings</span>
					</summary>
					<div className="settings-fields"></div>
				</details>
				<div className="quick-actions" aria-label="Code actions">
					<button type="button" data-action="quick" data-task="Explain Code">
						Explain
					</button>
					<button type="button" data-action="quick" data-task="Fix Bugs">
						Fix bugs
					</button>
					<button type="button" data-action="quick" data-task="Refactor">
						Refactor
					</button>
					<button type="button" data-action="quick" data-task="Add Comments">
						Comments
					</button>
				</div>
			</header>
			<div className="copilot-messages" role="log" aria-live="polite"></div>
			<form className="copilot-composer">
				<textarea
					rows="2"
					placeholder="Ask about your code"
					aria-label="Message"
				/>
				<div className="composer-actions">
					<button
						className="cancel-request"
						type="button"
						title="Cancel response"
					>
						Stop
					</button>
					<button className="send-request" type="submit">
						Send
					</button>
				</div>
			</form>
		</div>
	);
	container.content = root;
	messagesElement = root.querySelector(".copilot-messages");
	form = root.querySelector(".copilot-composer");
	input = form.querySelector("textarea");
	sendButton = form.querySelector(".send-request");
	cancelButton = form.querySelector(".cancel-request");
	contextToggle = root.querySelector(".context-toggle input");
	settingsForm = root.querySelector(".settings-fields");

	populateSettings();
	contextToggle.checked = getSettings().contextEnabled === true;
	contextToggle.addEventListener("change", onContextToggle);
	form.addEventListener("submit", onSubmit);
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			form.requestSubmit();
		}
	});
	cancelButton.addEventListener("click", () => controller?.abort());
	root.addEventListener("click", onAction);

	return () => {
		controller?.abort();
		controller = null;
		form.removeEventListener("submit", onSubmit);
		root.removeEventListener("click", onAction);
		history = [];
	};
}

function populateSettings() {
	const settings = getSettings();
	const fields = [
		[
			"Provider",
			<select name="provider">
				<option value="anthropic">Anthropic Claude</option>
				<option value="openai">OpenAI-compatible</option>
			</select>,
		],
		[
			"API key",
			<input
				name="apiKey"
				type="password"
				autocomplete="new-password"
				placeholder="Stored on this device"
			/>,
		],
		["Endpoint", <input name="endpoint" type="url" autocomplete="off" />],
		["Model", <input name="model" type="text" autocomplete="off" />],
		[
			"Max response tokens",
			<input name="maxTokens" type="number" min="1" max="32768" step="1" />,
		],
	];
	settingsForm.replaceChildren(
		...fields.map(([label, control]) => {
			control.value = settings[control.name];
			return (
				<label className="setting-field">
					<span>{label}</span>
					{control}
				</label>
			);
		}),
	);

	settingsForm.addEventListener("change", onSettingsChange);
}

async function saveSettings(changes) {
	const settings = { ...getSettings(), ...changes };
	await appSettings.update({ aiCopilot: settings }, false);
}

function onContextToggle() {
	void saveSettings({ contextEnabled: contextToggle.checked });
	if (contextToggle.checked) return;
	controller?.abort();
	history = [];
	messagesElement.replaceChildren();
	appendStatus(
		"Editor context disabled. Conversation cleared so prior code is not reused.",
	);
}

function onSettingsChange(event) {
	const field = event.target;
	if (!field.name) return;
	if (field.name === "provider") {
		const settings = getSettings();
		const provider = field.value;
		const priorDefault = defaultEndpoint(settings.provider);
		const next = { provider };
		if (!settings.endpoint || settings.endpoint === priorDefault) {
			next.endpoint = defaultEndpoint(provider);
			settingsForm.querySelector('[name="endpoint"]').value = next.endpoint;
		}
		if (
			!settings.model ||
			settings.model === "claude-sonnet-4-5" ||
			settings.model === "gpt-4o-mini"
		) {
			next.model =
				provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini";
			settingsForm.querySelector('[name="model"]').value = next.model;
		}
		void saveSettings(next);
		return;
	}
	const value = field.name === "maxTokens" ? Number(field.value) : field.value;
	void saveSettings({ [field.name]: value });
}

function captureEditorContext() {
	const file = editorManager.activeFile;
	const editor = editorManager.editor;
	if (!file || file.type !== "editor" || !editor?.state?.doc) return null;

	const state = editor.state;
	const selection = state.selection.main;
	const selectedText = state.doc.sliceString(selection.from, selection.to);
	const fullText = state.doc.toString();
	const useSelection = selectedText.length > 0;
	const originalText = useSelection ? selectedText : fullText;
	const limit = 12000;
	const shortened = originalText.length > limit;
	const text = shortened ? originalText.slice(0, limit) : originalText;
	const filename = file.filename || file.name || file.uri || "current file";
	const context = `File: ${filename}\n${useSelection ? "Selected code" : "File content"}${shortened ? " (shortened to 12,000 characters)" : ""}:\n${text}`;

	return {
		context,
		code: text,
		shortened,
		target: {
			file,
			editor,
			from: useSelection ? selection.from : 0,
			to: useSelection ? selection.to : state.doc.length,
			originalText,
			selected: useSelection,
			canApply: !shortened,
		},
	};
}

async function onSubmit(event) {
	event.preventDefault();
	await sendMessage(input.value.trim());
}

async function sendMessage(text, task = "") {
	if (!text || controller) return;
	const settings = getSettings();
	const context = settings.contextEnabled ? captureEditorContext() : null;
	if (task && (!context?.code || !context.code.trim())) {
		appendStatus(
			"No code is available. Enable editor context and select code or open a file.",
		);
		return;
	}

	const userText = task ? `${task}: ${text}` : text;
	let requestText = userText;
	if (context?.context) {
		requestText += `\n\n${context.context}`;
		if (context.shortened) {
			requestText +=
				"\nOnly the included portion is available; do not assume omitted code.";
		}
	}

	history.push({ role: "user", content: requestText });
	appendMessage("user", userText);
	input.value = "";
	controller = new AbortController();
	setBusy(true);
	const assistant = { role: "assistant", content: "" };
	history.push(assistant);
	const messageView = createMessage(
		"assistant",
		assistant.content,
		context?.target || null,
	);
	messagesElement.append(messageView.element);
	messagesElement.scrollTop = messagesElement.scrollHeight;

	try {
		await streamCompletion(
			settings,
			history.slice(0, -1),
			(delta) => {
				assistant.content += delta;
				messageView.update(assistant.content);
				messagesElement.scrollTop = messagesElement.scrollHeight;
			},
			controller.signal,
		);
	} catch (error) {
		if (controller.signal.aborted) {
			assistant.content = assistant.content || "Response cancelled.";
		} else {
			assistant.content = assistant.content
				? `${assistant.content}\n\nRequest interrupted: ${error.message}`
				: error.message ||
					"The AI request failed. Check provider settings and try again.";
		}
		messageView.update(assistant.content);
	} finally {
		controller = null;
		setBusy(false);
	}
}

function appendStatus(text) {
	const entry = createMessage("assistant", text, null);
	messagesElement.append(entry.element);
	messagesElement.scrollTop = messagesElement.scrollHeight;
}

function appendMessage(role, text, target = null) {
	const entry = createMessage(role, text, target);
	messagesElement.append(entry.element);
}

function createMessage(role, initialText, target) {
	const article = document.createElement("article");
	article.className = `copilot-message ${role}`;
	const heading = document.createElement("div");
	heading.className = "message-heading";
	const speaker = document.createElement("strong");
	speaker.textContent = role === "user" ? "You" : "AI Copilot";
	const copyResponse = document.createElement("button");
	copyResponse.type = "button";
	copyResponse.className = "message-copy";
	copyResponse.dataset.action = "copy-response";
	copyResponse.textContent = "Copy response";
	heading.append(speaker, copyResponse);
	const body = document.createElement("div");
	body.className = "message-body";
	article.append(heading, body);
	const entry = { element: article, content: initialText, target };
	article._copilotEntry = entry;
	updateMessageBody(entry, body, initialText);
	return {
		element: article,
		update(text) {
			entry.content = text;
			updateMessageBody(entry, body, text);
		},
	};
}

function updateMessageBody(entry, body, text) {
	body.replaceChildren();
	if (entry.element.classList.contains("user")) {
		body.textContent = text;
		return;
	}

	const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
	let cursor = 0;
	let match;
	while ((match = pattern.exec(text))) {
		if (match.index > cursor)
			body.append(document.createTextNode(text.slice(cursor, match.index)));
		const wrapper = document.createElement("div");
		wrapper.className = "code-proposal";
		const code = document.createElement("pre");
		const codeElement = document.createElement("code");
		codeElement.textContent = match[2].replace(/\n$/, "");
		code.append(codeElement);
		const actions = document.createElement("div");
		actions.className = "code-actions";
		const copy = document.createElement("button");
		copy.type = "button";
		copy.dataset.action = "copy-code";
		copy.textContent = "Copy code";
		copy._codeText = codeElement.textContent;
		actions.append(copy);
		if (entry.target) {
			const apply = document.createElement("button");
			apply.type = "button";
			apply.dataset.action = "apply-code";
			apply.textContent = "Apply to editor";
			apply._codeText = codeElement.textContent;
			apply._target = entry.target;
			apply.disabled = !entry.target.canApply;
			if (!entry.target.canApply)
				apply.title =
					"Apply is unavailable because the supplied code was shortened.";
			actions.append(apply);
		}
		wrapper.append(code, actions);
		body.append(wrapper);
		cursor = pattern.lastIndex;
	}
	if (cursor < text.length)
		body.append(document.createTextNode(text.slice(cursor)));
	if (!text) body.textContent = "Generating...";
}

async function onAction(event) {
	const button = event.target.closest("button[data-action]");
	if (!button || !root.contains(button)) return;
	if (button.dataset.action === "quick") {
		await sendMessage(
			`Please ${button.dataset.task.toLowerCase()} for the available code. Analyze it, explain the changes, and provide the complete replacement in one fenced code block.`,
			button.dataset.task,
		);
		return;
	}
	if (button.dataset.action === "copy-response") {
		await copyText(button.closest(".copilot-message")._copilotEntry.content);
		return;
	}
	if (button.dataset.action === "copy-code") {
		await copyText(button._codeText);
		return;
	}
	if (button.dataset.action === "apply-code") {
		await applyCode(button._target, button._codeText);
	}
}

async function copyText(text) {
	try {
		if (typeof cordova !== "undefined" && cordova.plugins?.clipboard?.copy) {
			cordova.plugins.clipboard.copy(text);
		} else if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
		} else {
			throw new Error("Clipboard is unavailable.");
		}
	} catch {
		appendStatus("Could not copy to the clipboard.");
	}
}

async function applyCode(target, replacement) {
	const accepted = await confirm(
		"Apply AI change",
		"Replace the code captured for this request?",
		false,
	);
	if (!accepted) return;

	const editor = editorManager.editor;
	const file = editorManager.activeFile;
	if (editor !== target.editor || file !== target.file || !editor?.state?.doc) {
		appendStatus(
			"The active file changed. Ask for a new proposal before applying.",
		);
		return;
	}
	const currentText = editor.state.doc.sliceString(target.from, target.to);
	if (currentText !== target.originalText) {
		appendStatus(
			"The code changed since this proposal. Ask for a new proposal before applying.",
		);
		return;
	}
	if (target.selected) {
		const selection = editor.state.selection.main;
		if (selection.from !== target.from || selection.to !== target.to) {
			appendStatus(
				"The selection changed since this proposal. Select the original code and try again.",
			);
			return;
		}
	}
	editor.dispatch({
		changes: { from: target.from, to: target.to, insert: replacement },
	});
}

function setBusy(busy) {
	sendButton.disabled = busy;
	input.disabled = busy;
	cancelButton.hidden = !busy;
}
