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

		/** Required service: the UI slot registry. */
		const inject = ["slots"];

		/** Projection key published by the host half. */
		const PROJECTION_KEY = "jevEffort";

		/** Effort ids that read as "barely thinking" and take the muted colour. */
		const QUIET = ["off", "minimal", "low"];

		/* ── Styles ─────────────────────────────────────────────── */

		/* Sits in the same row as the model selector: nudged down 2px so the
		   text baselines line up, and 12px so it reads as secondary chrome
		   next to the selector's own label. */
		const chipStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: "4px",
			fontSize: "12px",
			lineHeight: 1.5,
			padding: "4px 8px",
			marginTop: "2px",
			marginLeft: "8px",
			borderRadius: "6px",
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

		/**
		 * Register the chip once the composer's right-hand row is declared.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register(
				{ name: "conversation.input.right", id: "jev-effort", order: 50 },
				EffortChip,
			));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
