// semver 7.5 ships no types; the store only needs satisfies.
declare module "semver" {
  const semver: { satisfies(version: string, range: string): boolean };
  export default semver;
}
