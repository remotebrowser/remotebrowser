export const parseSecrets = (value) => {
  if (!value) return [];
  return value
    .split(',')
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0);
};
