import { parseFeatures, applyThinkConfig, applySearchConfig } from './features.js';
import { runSandboxCode } from './sandboxRunner.js';

export function transformRequest(incomingBody, provider, strippedModel, requestPath, reqHeaders, reqMethod, expressReq, expressRes) {
    var features = parseFeatures(incomingBody, reqHeaders);
    var hasFeatures = Object.keys(features).length > 0;
    if (hasFeatures) console.log('[transform] detected features:', JSON.stringify(features));

    var handled = {};
    var workingBody = JSON.parse(JSON.stringify(incomingBody));
    var codeOverrides = {
        url: null, url_path: null, headers: null, method: null,
        response_format: null, response_parser: null, stream_content_type: null,
        retry_codes: null, timeout: null
    };

    if (provider.sandbox_code) {
        var requestContext = {
            path: requestPath,
            method: reqMethod || 'POST',
            original_model: incomingBody.model || '',
            stripped_model: strippedModel || '',
        };

        var codeResult = runSandboxCode(provider.sandbox_code, workingBody, features, provider, requestContext, expressReq, expressRes);
        
        if (codeResult.hijacked) {
            console.log('[transform] sandbox code HIJACKED the connection. Proxy halting.');
            return { hijacked: true };
        }

        if (codeResult.error) {
            console.warn('[transform] sandbox code error for "' + provider.prefix + '": ' + codeResult.error);
        }

        workingBody = codeResult.body;
        handled = codeResult.handled;
        codeOverrides.url = codeResult.url;
        codeOverrides.url_path = codeResult.url_path;
        codeOverrides.headers = codeResult.headers;
        codeOverrides.method = codeResult.method;
        codeOverrides.response_format = codeResult.response_format;
        codeOverrides.response_parser = codeResult.response_parser;
        codeOverrides.stream_content_type = codeResult.stream_content_type;
        codeOverrides.retry_codes = codeResult.retry_codes;
        codeOverrides.timeout = codeResult.timeout;
        codeOverrides.sandbox_error = codeResult.error || null;
    }

    if (features.think && !handled.think && provider.think_config) applyThinkConfig(workingBody, features.think, provider.think_config);
    if (features.search && !handled.search && provider.search_config) applySearchConfig(workingBody, features.search, provider.search_config);

    var sandbox = provider.sandbox || null;

    if (!sandbox) {
        if (strippedModel) workingBody.model = strippedModel;
        var defaultHeaders = buildDefaultHeaders(provider);
        if (codeOverrides.headers) {
            for (var hk in codeOverrides.headers) defaultHeaders[hk] = codeOverrides.headers[hk];
        }
        return {
            url: codeOverrides.url || null, url_path: codeOverrides.url_path || requestPath,
            headers: defaultHeaders, body: workingBody, method: codeOverrides.method || null,
            response_format: codeOverrides.response_format || null, response_parser: codeOverrides.response_parser || null,
            stream_content_type: codeOverrides.stream_content_type || null, retry_codes: codeOverrides.retry_codes || null, timeout: codeOverrides.timeout || null,
            sandbox_error: codeOverrides.sandbox_error || null
        };
    }

    var urlPath = codeOverrides.url_path || sandbox.url_path || requestPath;
    var systemMsg = '';
    var nonSystemMessages = workingBody.messages || [];
    if (Array.isArray(nonSystemMessages)) {
        var sysIdx = -1;
        for (var i = 0; i < nonSystemMessages.length; i++) {
            if (nonSystemMessages[i].role === 'system') { sysIdx = i; break; }
        }
        if (sysIdx !== -1) {
            systemMsg = nonSystemMessages[sysIdx].content || '';
            nonSystemMessages = nonSystemMessages.filter(function(_, idx) { return idx !== sysIdx; });
        }
    }

    var body;
    if (sandbox.body_template) {
        body = JSON.parse(JSON.stringify(sandbox.body_template));
        body = replacePlaceholders(body, {
            '{{MODEL}}': strippedModel || workingBody.model || '',
            '{{MESSAGES}}': workingBody.messages || [],
            '{{SYSTEM_MESSAGE}}': systemMsg,
            '{{NON_SYSTEM_MESSAGES}}': nonSystemMessages,
        });
        if (workingBody && typeof workingBody === 'object') {
            var templateKeys = Object.keys(body);
            for (var key in workingBody) {
                if (key === 'model' || key === 'messages') continue;
                if (templateKeys.indexOf(key) === -1) body[key] = workingBody[key];
            }
        }
    } else {
        body = JSON.parse(JSON.stringify(workingBody));
        if (strippedModel) body.model = strippedModel;
    }

    if (sandbox.forced_fields) deepMerge(body, sandbox.forced_fields);

    var headers = sandbox.headers ? JSON.parse(JSON.stringify(sandbox.headers)) : buildDefaultHeaders(provider);
    if (codeOverrides.headers) {
        for (var hk2 in codeOverrides.headers) headers[hk2] = codeOverrides.headers[hk2];
    }

    return {
        url: codeOverrides.url || null, url_path: urlPath,
        headers: headers, body: body, method: codeOverrides.method || null,
        response_format: codeOverrides.response_format || null, response_parser: codeOverrides.response_parser || null,
        stream_content_type: codeOverrides.stream_content_type || null, retry_codes: codeOverrides.retry_codes || null, timeout: codeOverrides.timeout || null,
        sandbox_error: codeOverrides.sandbox_error || null
    };
}

export function injectKey(headers, key) {
    var result = {};
    for (var k in headers) result[k] = (typeof headers[k] === 'string') ? headers[k].replace(/{{KEY}}/g, key) : headers[k];
    return result;
}

export function buildDefaultHeaders(provider) {
    var h = { 'content-type': 'application/json' };
    var authType = (provider.auth_type || 'bearer').toLowerCase();
    var authHeader = provider.auth_header || 'authorization';
    if (authType === 'bearer') h[authHeader] = 'Bearer {{KEY}}';
    else if (authType === 'x-api-key') h['x-api-key'] = '{{KEY}}';
    else h[authHeader] = '{{KEY}}';
    return h;
}

function replacePlaceholders(obj, map) {
    if (typeof obj === 'string') {
        for (var ph in map) {
            if (obj === ph) return map[ph];
            if (obj.indexOf(ph) !== -1) {
                var val = map[ph];
                obj = obj.split(ph).join(typeof val === 'string' ? val : JSON.stringify(val));
            }
        }
        return obj;
    }
    if (Array.isArray(obj)) return obj.map(function(item) { return replacePlaceholders(item, map); });
    if (obj && typeof obj === 'object') {
        var out = {};
        for (var k in obj) out[k] = replacePlaceholders(obj[k], map);
        return out;
    }
    return obj;
}

function deepMerge(target, source) {
    for (var k in source) {
        var v = source[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
        else target[k] = v;
    }
}
