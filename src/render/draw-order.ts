import type { GraphNode, MeshInstance, Vec3 } from 'playcanvas';

/**
 * How far one place in a model's order moves its draw along the view, in metres. The engine adds
 * a draw's bucket, 127·10⁹ by default, to its distance before sorting, which leaves steps of
 * about 1.5·10⁻⁵ m. This is well clear of them, and a model's few dozen draws still span only
 * centimetres.
 */
export const ORDER_STEP = 1e-3;

/**
 * Sort a model's draws, in a layer that sorts back to front, as Q3 sorts one entity's: all by one
 * point, the model's origin, and among themselves by their `drawOrder`, the order the model adds
 * them in. Q3 keys a draw by its shader and then its entity, never by distance
 * (`R_AddDrawSurf`), so a model's surfaces of one shader draw in the order it added them. Sorted
 * by their own bounds instead, two overlapping blended surfaces could swap as the view or the
 * frame changed.
 *
 * A layer that sorts by hand reads only the `drawOrder`, and an opaque pass neither.
 *
 * @param origin - The model's own node, read wherever it is when the layer sorts.
 */
export function sortAsModel(draws: Iterable<MeshInstance>, origin: GraphNode): void {
  const distance = (draw: MeshInstance, camera: Vec3, forward: Vec3): number => {
    const at = origin.getPosition();
    return (
      (at.x - camera.x) * forward.x +
      (at.y - camera.y) * forward.y +
      (at.z - camera.z) * forward.z -
      draw.drawOrder * ORDER_STEP
    );
  };
  for (const draw of draws) draw.calculateSortDistance = distance;
}
