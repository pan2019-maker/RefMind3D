export interface CameraMotion { x: number; y: number; speed: number }
export interface WorldViewport { x: number; y: number; width: number; height: number }

/** Builds a forward loading corridor from recent camera velocity. */
export function predictedViewport(current: WorldViewport, motion: CameraMotion): WorldViewport {
  const magnitude = Math.hypot(motion.x, motion.y);
  if (magnitude < 0.001) return current;
  const nx = motion.x / magnitude;
  const ny = motion.y / magnitude;
  const lookAhead = Math.min(1.25, Math.max(.35, motion.speed * .18));
  const margin = .2;
  return {
    x: current.x - current.width * margin + nx * current.width * lookAhead,
    y: current.y - current.height * margin + ny * current.height * lookAhead,
    width: current.width * (1 + margin * 2),
    height: current.height * (1 + margin * 2)
  };
}
