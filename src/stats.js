import { Router } from 'express';
import { getStats, recordRequest as _record, getProvider } from './storage.js';

export var statsRouter = Router();

var activeSessions = new Map();
var ACTIVE_WINDOW = 60000;

setInterval(function() {
  var now = Date.now();
  for (var entry of activeSessions) {
    if (now - entry[1] > ACTIVE_WINDOW) activeSessions.delete(entry[0]);
  }
}, 15000);

export function trackRequest(req, _res, next) {
  if (req.path.startsWith('/api/') || req.path === '/v1/models' || req.path === '/health') return next();
  if (req.method === 'GET') return next();

  var ip = req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : (req.socket ? req.socket.remoteAddress : 'unknown') || 'unknown';
  activeSessions.set(ip, Date.now());
  next();
}

export function recordProxyRequest(prefix, ip, errored) {
  errored = errored || false;
  _record(prefix, ip, errored);
  activeSessions.set(ip, Date.now());
}

statsRouter.get('/', function(_req, res) {
  var stats = getStats();
  var now = Date.now();
  var activeCount = 0;
  for (var entry of activeSessions) {
    if (now - entry[1] <= ACTIVE_WINDOW) activeCount++;
  }

  var visibleProviders = {};
  var cloakedAggregate = { requests: 0, errors: 0, uniqueUsers: 0 };
  var hasCloaked = false;

  for (var key in stats.providers) {
    var prov = getProvider(key);
    var s = stats.providers[key];
    if (prov && prov.cloaked) {
      hasCloaked = true;
      cloakedAggregate.requests += s.requests;
      cloakedAggregate.errors += s.errors;
      cloakedAggregate.uniqueUsers += (s.uniqueIps ? s.uniqueIps.length : 0);
    } else {
      visibleProviders[key] = {
        requests: s.requests,
        errors: s.errors,
        uniqueUsers: s.uniqueIps ? s.uniqueIps.length : 0,
      };
    }
  }

  if (hasCloaked) {
    visibleProviders['cloaked'] = cloakedAggregate;
  }

  res.json({
    totalRequests: stats.totalRequests,
    totalErrors: stats.totalErrors,
    totalUniqueUsers: stats.uniqueIps.length,
    activeNow: activeCount,
    providers: visibleProviders,
  });
});
