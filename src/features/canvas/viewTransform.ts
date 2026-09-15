export interface CameraView {
  x: number;
  y: number;
  scale: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface WorldOrigin {
  x: number;
  y: number;
}

const ORIGIN_GRID = 100_000;

/**
 * Chooses an origin close to the camera. Rendering relative to this point keeps
 * CSS pixel operands small even on boards millions of units from (0, 0).
 */
export function stableWorldOrigin(view: CameraView, viewport: ViewportSize): WorldOrigin {
  const centerX = (-view.x + viewport.width / 2) / view.scale;
  const centerY = (-view.y + viewport.height / 2) / view.scale;
  return {
    x: Math.round(centerX / ORIGIN_GRID) * ORIGIN_GRID,
    y: Math.round(centerY / ORIGIN_GRID) * ORIGIN_GRID
  };
}

export function worldToScreen(
  point: { x: number; y: number },
  view: CameraView,
  origin: WorldOrigin
) {
  const localViewX = view.x + origin.x * view.scale;
  const localViewY = view.y + origin.y * view.scale;
  return {
    x: (point.x - origin.x) * view.scale + localViewX,
    y: (point.y - origin.y) * view.scale + localViewY
  };
}

export function screenToWorld(
  point: { x: number; y: number },
  view: CameraView,
  origin: WorldOrigin
) {
  const localViewX = view.x + origin.x * view.scale;
  const localViewY = view.y + origin.y * view.scale;
  return {
    x: (point.x - localViewX) / view.scale + origin.x,
    y: (point.y - localViewY) / view.scale + origin.y
  };
}
