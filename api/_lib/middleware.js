import { parse } from 'cookie';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'devbox-fallback-development-secret-key';

export { JWT_SECRET };

/**
 * Extracts and decodes the JWT token from the Request headers.
 * @param {object} req - Express request object
 * @returns {object|null} The decoded token payload or null if invalid
 */
export function getAuthUser(req) {
  try {
    const cookies = parse(req.headers.cookie || '');
    const token = cookies.auth_token;
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Enforces authentication. If not logged in, returns a 401 response.
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {object|null} The decoded user object or null
 */
export function requireAuth(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    res.status(401).json({ status: 'error', message: 'Unauthorized. Please log in.' });
    return null;
  }
  return user;
}

/**
 * Enforces admin authorization. If not an admin, returns a 403 response.
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 * @returns {object|null} The decoded admin user object or null
 */
export function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (!user.isAdmin && !user.is_admin) {
    res.status(403).json({ status: 'error', message: 'Forbidden. Admin privileges required.' });
    return null;
  }
  return user;
}
