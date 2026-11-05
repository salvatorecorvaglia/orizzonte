import type { Ecosystem } from './types.js';

/** Java selectors and mutable aliases cannot identify a concrete advisory version. */
export function isConcreteVersion(
  ecosystem: Ecosystem,
  version: string,
): boolean {
  if (ecosystem !== 'maven' && ecosystem !== 'gradle') return true;
  return (
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version) &&
    !/^(?:LATEST|RELEASE|latest\.(?:release|integration))$/i.test(version) &&
    !/-SNAPSHOT$/i.test(version) &&
    !(ecosystem === 'gradle' && version.includes('+'))
  );
}
