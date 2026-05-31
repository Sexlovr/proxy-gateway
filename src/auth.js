var DELETE_PASSWORD = process.env.DELETE_PASSWORD || 'changeme';

export function verifyPassword(input) {
  return input === DELETE_PASSWORD;
}

export function verifyProviderAccess(input, providerPassword) {
  if (!input) return false;
  if (providerPassword && input === providerPassword) return true;
  return hasAdminSession(input);
}

function hasAdminSession(token) {
  if (!token) return false;
  var systemKey = process.env.DELETE_PASSWORD || '';
  if (!systemKey) return false;
  return token === systemKey;
}
