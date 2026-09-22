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

		/** Required services: the UI slot registry and the settings transport. */
		const inject = ["slots", "settingsScope"];

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
			{ field: "apiUrl", kind: "text", label: "接口地址", hint: "Jev System One 接口的完整地址。" },
			{ field: "apiKey", kind: "secret", label: "密钥", hint: "留空则读取下方环境变量。" },
			{ field: "apiKeyEnv", kind: "text", label: "密钥环境变量", hint: "密钥留空时从该环境变量读取。" },
			{ field: "model", kind: "text", label: "Jev 模型", hint: "用于判断推理等级的模型路由。" },
			{ field: "confidenceThreshold", kind: "number", label: "置信度阈值", hint: "低于该值时，在概率最高的两档中选更高的那个。" },
			{ field: "timeoutMs", kind: "number", label: "超时时间（毫秒）", hint: "超时后跳过 Jev，沿用调用方已解析出的等级。" },
			{ field: "useContext", kind: "boolean", label: "发送上下文信封", hint: "附带上一轮等级、上一条消息与会话标题，让「继续」这类追问继承话题深度。" },
		];
		const SPEC = new Map(FIELDS.map((f) => [f.field, f]));

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
			constructor(scope) {
				this.scope = scope;
				/** field -> { kind: 'set', value } | { kind: 'clear' } | { kind: 'draft', text } */
				this.staged = new Map();
				this.saving = false;
				this.failed = false;
				this.store = runtime.createSnapshotStore(this.projection());
			}

			/** Follow scope changes; the returned disposer belongs to an effect. */
			attach() {
				return this.scope.subscribe(() => this.publish());
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
				};
			}

			actions() {
				return {
					edit: (field, text) => { this.staged.set(field, { kind: "draft", text }); this.publish() },
					toggle: (field, value) => { this.staged.set(field, { kind: "set", value }); this.publish() },
					resetField: (field) => { this.staged.set(field, { kind: "clear" }); this.publish() },
					discard: () => { this.staged.clear(); this.failed = false; this.publish() },
					save: () => { void this.save() },
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
						if (staged.kind === "clear") {
							await this.scope.unset(field);
						} else {
							const spec = SPEC.get(field);
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
			card: { border: ".5px solid var(--dsw-alias-border-l4)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: "16px", listStyle: "none" },
			header: { appearance: "none", width: "100%", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", background: "0 0", border: 0, borderRadius: "12px", alignItems: "center", gap: "12px", padding: "14px 16px", display: "flex" },
			headText: { flexDirection: "column", flex: 1, gap: "4px", minWidth: 0, display: "flex" },
			name: { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: 600, lineHeight: 1.4 },
			desc: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: 1.5 },
			pending: { flex: "none", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
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
		 * The plugin's settings card, collapsed until opened.
		 * @param props - owner props carrying the card's hook and actions.
		 */
		function SettingsCard(props) {
			const state = props.useJevCard((snapshot) => snapshot);
			const [open, setOpen] = React.useState(false);
			if (!state.available) return null;

			const disabled = !state.writable || state.saving;
			const blocked = !state.dirty || state.invalid || state.saving || !state.writable;

			return React.createElement("li", { style: cardCSS.card },
				React.createElement("button", {
					type: "button", style: cardCSS.header, "aria-expanded": open,
					onClick: () => setOpen(!open),
				},
					React.createElement("span", { style: cardCSS.headText },
						React.createElement("span", { style: cardCSS.name }, "Jev 推理选择"),
						React.createElement("span", { style: cardCSS.desc }, "由 Jev 判断每条消息该用多深的推理，自动切换当前模型的思考等级。")),
					state.dirty ? React.createElement("span", { style: cardCSS.pending }, "未保存") : null),
				open
					? React.createElement("div", { style: cardCSS.body },
						state.writable ? null : React.createElement("p", { style: cardCSS.readOnly }, "当前设置文档为只读，无法保存修改。"),
						FIELDS.map((spec) => React.createElement(Field, {
							key: spec.field, spec, state: state.fields[spec.field], actions: props, disabled,
						})),
						React.createElement("p", { style: cardCSS.readOnly }, "每个模型的档位映射（levels）请在 ~/.dsh/settings.yaml 中编辑。"),
						React.createElement("div", { style: cardCSS.footer },
							state.failed ? React.createElement("p", { style: cardCSS.failed }, "保存失败，请重试。") : null,
							React.createElement("button", {
								type: "button", style: { ...cardCSS.button, ...cardCSS.discard },
								disabled: !state.dirty || state.saving, onClick: props.discard,
							}, "放弃修改"),
							React.createElement("button", {
								type: "button", style: { ...cardCSS.button, ...cardCSS.save },
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

			const form = new JevForm(ctx.settingsScope.bind({ namespace: NS }));
			ctx.effect(() => form.attach(), "dsh-plugin-jev-effort-selector: settings scope subscription");
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: NS,
				inject: () => ({ hooks: { jevCard: form.store }, ...form.actions() }),
			}, SettingsCard));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
