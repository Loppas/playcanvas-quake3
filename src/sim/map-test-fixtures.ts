import { vec3, type Vec3 } from './vec3';

/**
 * Maps' entity text for tests, written as a `.ent` holds it: each entity a block of quoted
 * pairs, the world's first. A test builds the map it needs rather than reading a file.
 */

/** One entity as a test writes it: its keys and values, in order. */
export type TestEntity = Readonly<Record<string, string>>;

/** An entity text of these entities, in order. */
export function entityText(entities: readonly TestEntity[]): string {
  return entities
    .map((entity) => {
      const pairs = Object.entries(entity).map(([key, value]) => `"${key}" "${value}"\n`);
      return `{\n${pairs.join('')}}\n`;
    })
    .join('');
}

/**
 * An `info_player_deathmatch` at a point, facing a yaw. A pitch, which no map sets, is there for
 * a test that wants the spawn to look up or down.
 */
export function spawnSpot(origin: Vec3, yaw = 0, pitch = 0): TestEntity {
  return {
    classname: 'info_player_deathmatch',
    origin: `${origin.x} ${origin.y} ${origin.z}`,
    angles: `${pitch} ${yaw} 0`
  };
}

/** A map of a world and these entities. */
export function mapOf(...entities: TestEntity[]): string {
  return entityText([{ classname: 'worldspawn' }, ...entities]);
}

/** A map whose one spawn spot is the origin: every map the port had before maps had data. */
export const ORIGIN_MAP = mapOf(spawnSpot(vec3()));
