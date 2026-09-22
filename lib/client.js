/**
 * dsh-plugin-jev-effort-selector — browser half (hand-written lazy-CJS plugin bundle).
 *
 * Renders one chip in the composer's right-hand control row, beside the model
 * selector: the effort Jev picked for the current session and how sure it was.
 *
 * The value arrives through the standard `useProjection` prop, reading the
 * `jevEffort` projection the host half folds from its own session events.
 * That makes the chip session-scoped for free — no polling, no RPC, and no
 * chance of showing another conversation's decision.
 *
 * The settings form is not built here: the host half declares its schema, and
 * the harness renders and persists that section itself.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-jev-effort-selector",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		/* The snapshot-store factory moved packages across DSH versions; try the
		   current home first and fall back so one plugin build serves both. */
		let runtime;
		try {
			runtime = require("@deepseek-ai/dsh-client-store");
		} catch {
			runtime = require("@deepseek-ai/dsh-client-runtime/client");
		}

		/* The stock cards draw their disclosure affordance with the shared 14px
		   chevron primitive; require it so this card cannot drift from the
		   official icon, and keep an identical inline SVG for any host that
		   does not expose the primitives module. */
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch {
			primitives = null;
		}
		const CHEVRON_PATH = "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z";
		const ChevronDown = typeof primitives?.IconChevronDownOutline14 === "function"
			? primitives.IconChevronDownOutline14
			: () => React.createElement("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 14 14",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
			}, React.createElement("path", { d: CHEVRON_PATH, fill: "currentColor" }));

		/* The card's container states, copied from the stock plugin card so this
		   one darkens on open exactly like every other card in the tab. Inline
		   styles cannot express `:hover` or `:disabled`, so these few rules ride
		   a deduplicated <style> tag; everything else stays inline. */
		const CSS_TAG_ID = "dsh-plugin-jev-effort-selector/settings-card.css";
		const CSS = [
			".dshjev-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}",
			".dshjev-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".dshjev-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".dshjev-btn:disabled{opacity:.4;cursor:default}",
		].join("");
		if (typeof document !== "undefined"
			&& document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_TAG_ID);
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * Required services: the UI slot registry, the settings transport, and
		 * the credentials Remote namespace. The last one is how the API key is
		 * written without ever being read back — `describe` reports only whether
		 * a reference is configured, from which source, and whether this client
		 * may write it; no method on it can return a secret.
		 */
		const inject = ["slots", "settingsScope", "remote", "remote.credentials"];

		/** Settings namespace served by the host half. */
		const NS = "jev-effort-selector";

		/** Projection key published by the host half. */
		const PROJECTION_KEY = "jevEffort";

		/** Effort ids that read as "barely thinking" and take the muted colour. */
		const QUIET = ["off", "minimal", "low"];

		/**
		 * The settings card's fields, in display order. `levels` is deliberately
		 * absent: it is a map of arrays, which no scalar control can edit
		 * honestly — it belongs in `settings.yaml`.
		 */
		const FIELDS = [
			{ field: "enabled", kind: "boolean", label: "启用自动选择", hint: "关闭后保持你手动选择的推理等级。" },
			{ field: "apiUrl", kind: "text", label: "API 地址", hint: "Jev System One 接口的完整地址。" },
			{ field: "model", kind: "text", label: "Jev 模型", hint: "用于判断推理等级的模型路由。" },
			{ field: "confidenceThreshold", kind: "number", label: "置信度阈值", hint: "低于该值时，在概率最高的两档中选更高的那个。" },
			{ field: "timeoutMs", kind: "number", label: "超时时间（毫秒）", hint: "超时后跳过 Jev，沿用调用方已解析出的等级。" },
			{ field: "useContext", kind: "boolean", label: "发送上下文信封", hint: "附带上一轮等级、上一条消息与会话标题，让「继续」这类追问继承话题深度。" },
		];
		const SPEC = new Map(FIELDS.map((f) => [f.field, f]));

		/**
		 * The character set the stock Models page accepts for a key, reused
		 * verbatim so this card refuses exactly what that one refuses.
		 */
		const LEGAL_API_KEY = /^[\x21-\x7E]+$/;

		/**
		 * Reference the key is stored under. The settings schema still carries
		 * `apiKeyEnv` for anyone who wants a different name in settings.yaml, but
		 * the form does not show it: naming the slot is not a decision this card
		 * should ask a user to make.
		 */
		const DEFAULT_KEY_REF = "JEV_API_KEY";

		/* ── Styles ─────────────────────────────────────────────── */

		/* Shares the composer control row with the model selector, so it copies
		   that trigger's metrics verbatim (28px tall, 13px/500, 20px leading,
		   4px gap) and the two read as one row rather than two widgets. */
		const chipStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: "4px",
			height: "28px",
			fontSize: "13px",
			fontWeight: 500,
			lineHeight: "20px",
			padding: "0 4px 0 8px",
			whiteSpace: "nowrap",
			cursor: "default",
		};
		const nameStyle = { color: "var(--dsw-alias-label-primary)" };
		const confidenceStyle = { color: "var(--dsw-alias-label-secondary)" };

		/** Colour one effort id by how much thinking it buys. */
		function levelStyle(choice) {
			if (QUIET.indexOf(choice) !== -1) return { color: "var(--dsw-alias-label-secondary)" };
			if (choice === "medium") return { color: "var(--dsw-alias-state-warn-primary)" };
			return { color: "var(--dsw-alias-state-error-primary)" };
		}

		/** Title-case one effort id for display. */
		function label(choice) {
			return choice.charAt(0).toUpperCase() + choice.slice(1);
		}

		/**
		 * The composer chip: "Jev · Medium · 97%".
		 *
		 * Renders nothing until this session has a decision, so a fresh
		 * conversation shows no placeholder.
		 * @param props - session-scoped standard props from the slot owner.
		 */
		function EffortChip(props) {
			const decision = props.useProjection(PROJECTION_KEY);
			if (decision === undefined || decision === null) return null;

			const choice = typeof decision.choice === "string" ? decision.choice : "";
			if (choice === "") return null;

			const confidence = Math.round((decision.confidence || 0) * 100);

			return React.createElement("span", { style: chipStyle, title: "Reasoning effort chosen by Jev" },
				React.createElement("span", { style: nameStyle }, "Jev"),
				React.createElement("span", { style: levelStyle(choice) }, label(choice)),
				React.createElement("span", { style: confidenceStyle }, confidence + "%"),
			);
		}

		/* ── Settings card ──────────────────────────────────────── */

		/**
		 * Staged editor over the namespace scope: edits accumulate here and only
		 * reach the Host when Save runs, so a half-typed endpoint never lands.
		 */
		class JevForm {
			constructor(scope, credentials) {
				this.scope = scope;
				this.credentials = credentials;
				/** field -> { kind: 'set', value } | { kind: 'clear' } | { kind: 'draft', text } */
				this.staged = new Map();
				this.saving = false;
				this.failed = false;
				/**
				 * The key lives outside the settings document entirely. `configured`
				 * is the whole fact this card keeps — the describe view carries no
				 * slot a secret could ride in, and this object never holds one, not
				 * even transiently after a successful write.
				 */
				this.secret = { ref: "", known: false, configured: false, draft: "", busy: false, error: "" };
				this.store = runtime.createSnapshotStore(this.projection());
			}

			/** Follow scope changes; the returned disposer belongs to an effect. */
			attach() {
				const dispose = this.scope.subscribe(() => { this.publish(); this.syncSecret() });
				this.syncSecret();
				return dispose;
			}

			/**
			 * The reference the Host will actually resolve: the saved value, never
			 * a half-typed draft, so the status line cannot describe a name that
			 * is not in force yet.
			 */
			savedRef() {
				const value = this.snapshot().value;
				const ref = value === undefined || value === null ? undefined : value.apiKeyEnv;
				return typeof ref === "string" && ref !== "" ? ref : DEFAULT_KEY_REF;
			}

			/** Re-describe when the reference in force changed under us. */
			syncSecret() {
				const ref = this.savedRef();
				if (ref === this.secret.ref) return;
				this.secret = { ...this.secret, ref, known: false, configured: false, error: "" };
				this.publish();
				void this.describeSecret(ref);
			}

			/**
			 * Read one reference's status. A reply for a superseded name is
			 * dropped, so a fast rename cannot leave the older answer on screen.
			 */
			async describeSecret(ref) {
				if (ref === "") return;
				let configured = false;
				let error = "";
				try {
					// Every remote method answers a result envelope and reports refusal
					// through `ok: false` instead of rejecting. Reading the payload off
					// the envelope directly yields undefined forever — the status then
					// never settles, which is exactly what a missing `.value` looked
					// like on screen.
					const response = await this.credentials.describe([ref]);
					if (response?.ok) configured = response.value?.[ref]?.configured === true;
					else error = response?.error?.message ?? "无法读取密钥状态。";
				} catch {
					error = "无法读取密钥状态。";
				}
				if (this.secret.ref !== ref) return;
				this.secret = { ...this.secret, known: true, configured, error };
				this.publish();
			}

			/** Store the typed key through the credentials seam, then re-read its status. */
			async storeSecret() {
				const ref = this.secret.ref;
				const value = this.secret.draft.trim();
				if (this.secret.busy || ref === "" || value === "") return;
				if (!LEGAL_API_KEY.test(value)) {
					this.secret = { ...this.secret, error: "该 API 密钥格式错误，请检查。" };
					this.publish();
					return;
				}
				this.secret = { ...this.secret, busy: true, error: "" };
				this.publish();
				let error = "";
				try {
					// A refusal — most often a read-only layer shadowing the reference —
					// arrives as `ok: false` carrying the seam's own message, which is
					// what must be shown verbatim rather than a guess.
					const response = await this.credentials.set(ref, value);
					if (!response?.ok) error = response?.error?.message ?? "保存失败，请重试。";
				} catch {
					error = "保存失败，请重试。";
				}
				this.secret = { ...this.secret, busy: false, error, draft: error === "" ? "" : this.secret.draft };
				this.publish();
				if (error === "") await this.describeSecret(ref);
			}

			/** Remove the stored key; layers above the managed store are untouched. */
			async removeSecret() {
				const ref = this.secret.ref;
				if (this.secret.busy || ref === "") return;
				this.secret = { ...this.secret, busy: true, error: "" };
				this.publish();
				let error = "";
				try {
					const response = await this.credentials.unset(ref);
					if (!response?.ok) error = response?.error?.message ?? "清除失败，请重试。";
				} catch {
					error = "清除失败，请重试。";
				}
				this.secret = { ...this.secret, busy: false, error, draft: "" };
				this.publish();
				if (error === "") await this.describeSecret(ref);
			}

			publish() {
				this.store.set(this.projection());
			}

			snapshot() {
				return this.scope.getSnapshot();
			}

			/** Effective display state for one field: staged edit over resolved value. */
			fieldState(field) {
				const spec = SPEC.get(field);
				const snapshot = this.snapshot();
				const resolved = snapshot.value === undefined ? undefined : snapshot.value[field];
				const user = snapshot.user;
				const overridden = user !== undefined && user !== null && Object.hasOwn(user, field);
				const staged = this.staged.get(field);

				if (staged === undefined) {
					return { value: resolved, text: resolved === undefined ? "" : String(resolved), overridden, invalid: false, dirty: false };
				}
				if (staged.kind === "clear") {
					const base = snapshot.base === undefined || snapshot.base === null ? undefined : snapshot.base[field];
					return { value: base, text: base === undefined ? "" : String(base), overridden: false, invalid: false, dirty: true };
				}
				if (staged.kind === "set") {
					return { value: staged.value, text: String(staged.value), overridden: true, invalid: false, dirty: true };
				}
				const trimmed = staged.text.trim();
				const invalid = spec.kind === "number" && trimmed !== "" && !Number.isFinite(Number(trimmed));
				return { value: undefined, text: staged.text, overridden: true, invalid, dirty: true };
			}

			projection() {
				const snapshot = this.snapshot();
				let dirty = false;
				let invalid = false;
				const fields = {};
				for (const spec of FIELDS) {
					const state = this.fieldState(spec.field);
					fields[spec.field] = state;
					dirty = dirty || state.dirty;
					invalid = invalid || state.invalid;
				}
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					saving: this.saving,
					failed: this.failed,
					dirty,
					invalid,
					fields,
					secret: {
						/* `known` gates the status line so the row renders nothing at
						   all until the answer is in: a key is either configured or it
						   is not, and a transient "reading…" is noise either way. */
						known: this.secret.known,
						configured: this.secret.configured,
						draft: this.secret.draft,
						busy: this.secret.busy,
						error: this.secret.error,
					},
				};
			}

			actions() {
				return {
					edit: (field, text) => { this.staged.set(field, { kind: "draft", text }); this.publish() },
					toggle: (field, value) => { this.staged.set(field, { kind: "set", value }); this.publish() },
					resetField: (field) => { this.staged.set(field, { kind: "clear" }); this.publish() },
					discard: () => { this.staged.clear(); this.failed = false; this.publish() },
					save: () => { void this.save() },
					editSecret: (text) => { this.secret = { ...this.secret, draft: text, error: "" }; this.publish() },
					saveSecret: () => { void this.storeSecret() },
					clearSecret: () => { void this.removeSecret() },
				};
			}

			async save() {
				if (this.saving) return;
				const view = this.projection();
				if (!view.dirty || view.invalid || !view.writable) return;
				this.saving = true;
				this.failed = false;
				this.publish();

				let landed = true;
				for (const [field, staged] of [...this.staged]) {
					try {
						const spec = SPEC.get(field);
						// An emptied text box means "revert to the default", not
						// "store an empty string": persisting "" would leave the
						// plugin pointed at an unusable endpoint or reference with
						// no way back except the reset link.
						const blank = staged.kind === "draft" && staged.text.trim() === "";
						if (staged.kind === "clear" || blank) {
							await this.scope.unset(field);
						} else {
							let value = staged.kind === "set" ? staged.value : staged.text;
							if (staged.kind === "draft" && spec.kind === "number") value = Number(String(value).trim());
							await this.scope.set(field, value);
						}
						this.staged.delete(field);
					} catch {
						// Keep this edit staged so Save can be retried after the cause clears.
						landed = false;
					}
				}
				this.saving = false;
				this.failed = !landed;
				this.publish();
			}
		}

		const cardCSS = {
			header: { appearance: "none", width: "100%", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", background: "0 0", border: 0, borderRadius: "12px", alignItems: "center", gap: "12px", padding: "14px 16px", display: "flex" },
			headText: { flexDirection: "column", flex: 1, gap: "4px", minWidth: 0, display: "flex" },
			name: { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: 600, lineHeight: 1.4 },
			desc: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: 1.5 },
			pending: { flex: "none", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
			chevron: { display: "inline-flex", flex: "none", color: "var(--dsw-alias-label-tertiary)", transition: "transform .16s" },
			chevronOpen: { transform: "rotate(180deg)" },
			body: { borderTop: ".5px solid var(--dsw-alias-border-l2)", margin: "0 16px", paddingBottom: "8px" },
			field: { flexDirection: "column", gap: "6px", padding: "12px 0", display: "flex", borderTop: ".5px solid var(--dsw-alias-border-l2)" },
			fieldHead: { alignItems: "center", gap: "8px", display: "flex" },
			label: { minWidth: 0, color: "var(--dsw-alias-label-primary)", flex: 1, fontSize: "13px", fontWeight: 500, lineHeight: 1.5 },
			reset: { font: "inherit", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", background: "0 0", border: "none", padding: 0, fontSize: "12px", lineHeight: 1.5 },
			input: { border: ".5px solid var(--dsw-alias-border-l4)", background: "var(--dsw-alias-bg-layer-3)", height: "34px", font: "inherit", color: "var(--dsw-alias-label-primary)", borderRadius: "8px", padding: "0 12px", fontSize: "13px", lineHeight: 1.5, boxSizing: "border-box" },
			hint: { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: "12px", lineHeight: 1.5 },
			invalid: { color: "var(--dsw-alias-label-error)", margin: 0, fontSize: "12px", lineHeight: 1.5 },
			toggleRow: { color: "var(--dsw-alias-label-primary)", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", fontSize: "13px", lineHeight: 1.5, display: "flex" },
			toggleLabel: { flex: 1, minWidth: 0 },
			footer: { borderTop: ".5px solid var(--dsw-alias-border-l2)", justifyContent: "flex-end", alignItems: "center", gap: "8px", padding: "12px 0 4px", display: "flex" },
			failed: { minWidth: 0, color: "var(--dsw-alias-label-error)", flex: 1, margin: 0, fontSize: "12px", lineHeight: 1.5 },
			button: { appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid transparent", borderRadius: "8px", padding: "5px 14px", fontSize: "13px", lineHeight: 1.5 },
			discard: { borderColor: "var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", background: "0 0" },
			save: { background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)" },
			readOnly: { color: "var(--dsw-alias-label-tertiary)", margin: "12px 0 0", fontSize: "12px", lineHeight: 1.5 },
			secretRow: { display: "flex", alignItems: "center", gap: "8px" },
		};

		/** One field row: label, optional reset, control, hint. */
		function Field(props) {
			const { spec, state, actions, disabled } = props;
			const control = spec.kind === "boolean"
				? React.createElement("div", { style: cardCSS.toggleRow },
					React.createElement("div", { style: cardCSS.toggleLabel },
						React.createElement("div", { style: cardCSS.label }, spec.label),
						React.createElement("p", { style: cardCSS.hint }, spec.hint)),
					React.createElement("input", {
						type: "checkbox", checked: state.value === true, disabled,
						onChange: (e) => actions.toggle(spec.field, e.target.checked),
					}))
				: React.createElement(React.Fragment, null,
					React.createElement("div", { style: cardCSS.fieldHead },
						React.createElement("span", { style: cardCSS.label }, spec.label),
						state.overridden
							? React.createElement("button", { type: "button", style: cardCSS.reset, disabled, onClick: () => actions.resetField(spec.field) }, "恢复默认")
							: null),
					React.createElement("input", {
						type: spec.kind === "secret" ? "password" : spec.kind === "number" ? "number" : "text",
						value: state.text, disabled, style: cardCSS.input,
						onChange: (e) => actions.edit(spec.field, e.target.value),
					}),
					state.invalid
						? React.createElement("p", { style: cardCSS.invalid }, "请输入数字。")
						: React.createElement("p", { style: cardCSS.hint }, spec.hint));

			return React.createElement("div", { style: cardCSS.field }, control);
		}

		/**
		 * The API key row, written through the credentials seam rather than into
		 * the settings document.
		 *
		 * The value is never read back — the describe view carries only whether a
		 * key is stored — so the row states that one fact and nothing more, in
		 * the stock Models page's own words. Until the answer is in it states
		 * nothing at all: a placeholder that narrates the read tells the user
		 * about this card's plumbing rather than about their key.
		 * @param props - the credential view plus the card's actions.
		 */
		function SecretField(props) {
			const { secret, actions, disabled } = props;
			const locked = disabled || secret.busy;

			return React.createElement("div", { style: cardCSS.field },
				React.createElement("div", { style: cardCSS.fieldHead },
					React.createElement("span", { style: cardCSS.label }, "API 密钥")),
				React.createElement("div", { style: cardCSS.secretRow },
					React.createElement("input", {
						type: "password",
						value: secret.draft,
						disabled: locked,
						placeholder: "输入 API 密钥",
						style: { ...cardCSS.input, flex: 1, minWidth: 0 },
						onChange: (e) => actions.editSecret(e.target.value),
					}),
					React.createElement("button", {
						type: "button", className: "dshjev-btn",
						style: { ...cardCSS.button, ...cardCSS.save },
						disabled: locked || secret.draft.trim() === "",
						onClick: actions.saveSecret,
					}, secret.busy ? "保存中…" : "保存"),
					secret.known && secret.configured
						? React.createElement("button", {
							type: "button", className: "dshjev-btn",
							style: { ...cardCSS.button, ...cardCSS.discard },
							disabled: locked, onClick: actions.clearSecret,
						}, "清除")
						: null),
				secret.error !== ""
					? React.createElement("p", { style: cardCSS.invalid }, secret.error)
					: secret.known
						? React.createElement("p", { style: cardCSS.hint },
							secret.configured ? "API 密钥已配置" : "API 密钥缺失")
						: null);
		}

		/**
		 * The plugin's settings card, collapsed until opened.
		 * @param props - owner props carrying the card's hook and actions.
		 */
		function SettingsCard(props) {
			const state = props.useJevCard((snapshot) => snapshot);
			const [open, setOpen] = React.useState(false);
			if (!state.available) return null;

			const disabled = !state.writable || state.saving;
			const blocked = !state.dirty || state.invalid || state.saving || !state.writable;

			// The open state darkens the card to bg-layer-2, exactly as the stock
			// plugin cards do, so an expanded section reads as one surface with
			// the rest of the tab instead of staying flat at bg-layer-3.
			return React.createElement("li", { className: open ? "dshjev-card dshjev-cardOpen" : "dshjev-card" },
				React.createElement("button", {
					type: "button", style: cardCSS.header, "aria-expanded": open,
					onClick: () => setOpen(!open),
				},
					React.createElement("span", { style: cardCSS.headText },
						React.createElement("span", { style: cardCSS.name }, "Jev 推理选择"),
						React.createElement("span", { style: cardCSS.desc }, "由 Jev 判断每条消息该用多深的推理，自动切换当前模型的思考等级。")),
					state.dirty ? React.createElement("span", { style: cardCSS.pending }, "未保存") : null,
					React.createElement("span",
						{ style: open ? { ...cardCSS.chevron, ...cardCSS.chevronOpen } : cardCSS.chevron, "aria-hidden": true },
						React.createElement(ChevronDown, null))),
				open
					? React.createElement("div", { style: cardCSS.body },
						state.writable ? null : React.createElement("p", { style: cardCSS.readOnly }, "当前设置文档为只读，无法保存修改。"),
						FIELDS.map((spec) => {
							const row = React.createElement(Field, {
								key: spec.field, spec, state: state.fields[spec.field], actions: props, disabled,
							});
							// The key follows the endpoint it authenticates, mirroring
							// the stock Models page's 地址-then-密钥 ordering.
							if (spec.field !== "apiUrl") return row;
							return React.createElement(React.Fragment, { key: spec.field },
								row,
								React.createElement(SecretField, { secret: state.secret, actions: props, disabled }));
						}),
						React.createElement("p", { style: cardCSS.readOnly }, "每个模型的档位映射（levels）请在 ~/.dsh/settings.yaml 中编辑。"),
						React.createElement("div", { style: cardCSS.footer },
							state.failed ? React.createElement("p", { style: cardCSS.failed }, "保存失败，请重试。") : null,
							React.createElement("button", {
								type: "button", className: "dshjev-btn",
								style: { ...cardCSS.button, ...cardCSS.discard },
								disabled: !state.dirty || state.saving, onClick: props.discard,
							}, "放弃修改"),
							React.createElement("button", {
								type: "button", className: "dshjev-btn",
								style: { ...cardCSS.button, ...cardCSS.save },
								disabled: blocked, onClick: props.save,
							}, state.saving ? "保存中…" : "保存")))
					: null);
		}

		/**
		 * Register the composer chip and the settings card.
		 *
		 * The card is what puts this plugin in Settings: the Plugins tab shows the
		 * intersection of namespaces the Host serves and cards registered on
		 * `settings.plugin.item`, so registering the namespace alone renders nothing.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register(
				{ name: "conversation.input.right", id: "jev-effort", order: 50 },
				EffortChip,
			));

			const form = new JevForm(ctx.settingsScope.bind({ namespace: NS }), ctx.remote.credentials);
			ctx.effect(() => form.attach(), "dsh-plugin-jev-effort-selector: settings scope subscription");
			/* The configurable-plugins tab lists cards in slot-entry order, and the
			   ledger sorts by `priority` ascending (ties keep registration order).
			   Every stock card and the memory card sit at priority 0, so -1 pins
			   this card to the top of the list. */
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: NS,
				priority: -1,
				inject: () => ({ hooks: { jevCard: form.store }, ...form.actions() }),
			}, SettingsCard));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
