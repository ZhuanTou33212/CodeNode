import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

type Waypoint = { x: number; y: number };

function WaypointEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd, data }: EdgeProps) {
  const waypoints = ((data as { waypoints?: Waypoint[] } | undefined)?.waypoints) || [];
  const points = [
    { x: sourceX, y: sourceY },
    ...waypoints,
    { x: targetX, y: targetY },
  ];
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

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
