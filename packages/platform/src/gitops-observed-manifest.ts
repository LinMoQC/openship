export interface ObservedManifestContract {
  expectedServices: string[];
  services: Array<{ name: string; image: string }>;
  infrastructure?: Array<{ name: string; image: string }>;
}

/** Incumbent scope comes from its own immutable locked Compose document. */
export function observedManifestContract<T extends ObservedManifestContract>(
  stack: T, manifest: unknown, lockedCompose: unknown,
): T {
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const reject = (): never => { throw new AppError("Incumbent manifest differs from its immutable locked Compose scope", 409, "RELEASE_SOURCE_INVALID"); };
  const m = object(manifest), locked = object(object(lockedCompose).services);
  const services = object(m.services), infrastructure = object(m.infrastructure);
  const images = { ...services, ...infrastructure }, names = Object.keys(locked);
  if (!names.length || Object.keys(images).length !== Object.keys(services).length + Object.keys(infrastructure).length || names.some(name => !stack.expectedServices.includes(name))) reject();
  const appNames = new Set(stack.services.map(row => row.name)), infraNames = new Set((stack.infrastructure ?? []).map(row => row.name));
  if (Object.keys(services).some(name => !appNames.has(name)) || Object.keys(infrastructure).some(name => !infraNames.has(name)) || Object.keys(images).some(name => !names.includes(name))) reject();
  for (const name of names) {
    // The established migrate job uses the exact platform-api image. No
    // arbitrary service or task may inherit another service's provenance.
    const image = object(images[name] ?? (name === "migrate" ? services["platform-api"] : undefined));
    if (typeof image.image !== "string" || typeof image.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(image.digest) || object(locked[name]).image !== `${image.image}@${image.digest}`) reject();
  }
  return { ...stack, expectedServices: names, services: stack.services.filter(row => names.includes(row.name)),
    infrastructure: (stack.infrastructure ?? []).filter(row => names.includes(row.name)) };
}
import { AppError } from "@repo/core";
