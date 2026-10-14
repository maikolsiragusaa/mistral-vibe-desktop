export type CompanionState =
  "idle" | "thinking" | "working" | "waiting" | "completed" | "error";

/** An original lantern-shaped companion; every shape belongs to this project. */
export function PixelCompanion({
  state = "idle",
  large = false,
}: {
  state?: CompanionState;
  large?: boolean;
}) {
  return (
    <span
      className={`pixel-companion ${large ? "large" : ""}`}
      data-state={state}
      role="img"
      aria-label={`Ember: ${state}`}
    >
      <svg viewBox="0 0 20 22" shapeRendering="crispEdges" aria-hidden="true">
        <g className="companion-sparks" fill="currentColor">
          <rect x="1" y="3" width="2" height="2" />
          <rect x="17" y="7" width="2" height="2" />
          <rect x="14" y="0" width="2" height="2" />
        </g>
        <g className="companion-body">
          <path fill="#75413c" d="M7 2h6v2h2v3h2v11h-2v2H5v-2H3V7h2V4h2z" />
          <path fill="#ffae63" d="M7 4h6v3h2v10H5V7h2z" />
          <path fill="#ed6b3a" d="M5 7h2v10H5zM13 7h2v10h-2zM7 17h6v2H7z" />
          <path fill="#ffe5ae" d="M7 7h6v8H7z" />
          <g className="companion-eyes" fill="#373941">
            <rect x="7" y="10" width="2" height="2" />
            <rect x="11" y="10" width="2" height="2" />
          </g>
          <rect fill="#bc5034" x="9" y="14" width="2" height="1" />
          <path fill="#75413c" d="M5 20h4v2H5zM11 20h4v2h-4z" />
        </g>
        {state === "completed" && (
          <path
            className="companion-badge"
            fill="#407960"
            d="M14 1h2v2h2V1h2v4h-2v2h-2V5h-2z"
          />
        )}
        {state === "waiting" && (
          <path
            className="companion-badge"
            fill="#a66619"
            d="M16 1h2v4h-2zM16 6h2v2h-2z"
          />
        )}
        {state === "error" && (
          <path
            className="companion-badge"
            fill="#cd4c41"
            d="M14 1h2v2h2V1h2v2h-2v2h2v2h-2V5h-2v2h-2V5h2V3h-2z"
          />
        )}
      </svg>
    </span>
  );
}
