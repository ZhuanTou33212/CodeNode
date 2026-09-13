import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

type Waypoint = { x: number; y: number };

function distance(a: Waypoint, b: Waypoint) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function roundedWaypointPath(points: Waypoint[]) {
  if (points.length < 2) return '';

  // Blender 的 noodle 在没有中转点时是一条水平控制的贝塞尔曲线。
  if (points.length === 2) {
    const [source, target] = points;
    const direction = target.x >= source.x ? 1 : -1;
    const bend = Math.max(32, Math.min(180, Math.abs(target.x - source.x) * 0.5));
    return `M ${source.x} ${source.y} C ${source.x + bend * direction} ${source.y}, ${target.x - bend * direction} ${target.y}, ${target.x} ${target.y}`;
  }

  // 中转点只作为路径控制点，拐角使用二次曲线圆滑过渡，避免 SVG 折线的尖角和视觉噪声。
  const radius = Math.min(28, ...points.slice(1, -1).map((point, index) => {
    const previous = points[index];
    const next = points[index + 2];
    return Math.min(distance(previous, point), distance(point, next)) * 0.42;
  }));
  let path = `M ${points[0].x} ${points[0].y}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const next = points[index + 1];
    const inLength = Math.max(distance(previous, point), 0.001);
    const outLength = Math.max(distance(point, next), 0.001);
    const inRadius = Math.min(radius, inLength * 0.42);
    const outRadius = Math.min(radius, outLength * 0.42);
    const entry = {
      x: point.x - ((point.x - previous.x) / inLength) * inRadius,
      y: point.y - ((point.y - previous.y) / inLength) * inRadius,
    };
    const exit = {
      x: point.x + ((next.x - point.x) / outLength) * outRadius,
      y: point.y + ((next.y - point.y) / outLength) * outRadius,
    };
    path += ` L ${entry.x} ${entry.y} Q ${point.x} ${point.y}, ${exit.x} ${exit.y}`;
  }

  const target = points[points.length - 1];
  path += ` L ${target.x} ${target.y}`;
  return path;
}

function WaypointEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd, data }: EdgeProps) {
  const waypoints = ((data as { waypoints?: Waypoint[] } | undefined)?.waypoints) || [];
  const points = [
    { x: sourceX, y: sourceY },
    ...waypoints,
    { x: targetX, y: targetY },
  ];
  const path = roundedWaypointPath(points);

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        {waypoints.map((wp, i) => (
          <div
            key={i}
            className="wf-waypoint"
            style={{ transform: `translate(-50%, -50%) translate(${wp.x}px, ${wp.y}px)` }}
          />
        ))}
      </EdgeLabelRenderer>
    </>
  );
}

export default memo(WaypointEdge);
