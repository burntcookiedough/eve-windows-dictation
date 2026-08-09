export function buildChildEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  serverEnvironment: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const merged = { ...baseEnvironment, ...serverEnvironment, ...overrides };
  const serverPath = findPathValue(serverEnvironment);
  const basePath = findPathValue(baseEnvironment);
  const childEnvironment: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(merged)) {
    if (key.toLowerCase() === 'path' || value === undefined) continue;
    childEnvironment[key] = value;
  }

  const pathValue = serverPath ?? basePath;
  if (pathValue !== undefined) childEnvironment.PATH = pathValue;
  return childEnvironment;
}

function findPathValue(environment: NodeJS.ProcessEnv): string | undefined {
  if (environment.PATH !== undefined) return environment.PATH;
  return Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1];
}
