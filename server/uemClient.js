const axios = require('axios');
const { query } = require('./config/database');

/**
 * UEM API Client
 * Handles OAuth2 and Basic Auth, token caching, retries, and rate limiting
 */
class UEMClient {
  constructor(environment) {
    this.env = environment;
    this._tokenCache = null;
    this._tokenExpiry = null;
    this.timeout = parseInt(process.env.UEM_API_TIMEOUT) || 30000;
    this.maxRetries = parseInt(process.env.UEM_API_MAX_RETRIES) || 3;
    this.rateLimitDelay = parseInt(process.env.UEM_API_RATE_LIMIT_DELAY) || 200;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async getToken() {
    if (this.env.auth_type !== 'oauth2') return null;
    if (this._tokenCache && this._tokenExpiry > Date.now()) return this._tokenCache;

    const resp = await axios.post(this.env.oauth_token_url, new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.env.client_id,
      client_secret: this.env.client_secret,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    this._tokenCache = resp.data.access_token;
    this._tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
    return this._tokenCache;
  }

  async buildHeaders(version = 'v1') {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.env.auth_type === 'oauth2') {
      const token = await this.getToken();
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      const creds = Buffer.from(`${this.env.api_username}:${this.env.api_password}`).toString('base64');
      headers['Authorization'] = `Basic ${creds}`;
      if (this.env.api_key) headers['aw-tenant-code'] = this.env.api_key;
    }
    headers['Accept'] = `application/json;version=${version.replace('v', '')}`;
    return headers;
  }

  // ── Core request with retry ───────────────────────────────────────────────

  async request({ method = 'GET', path, params = {}, data, version = 'v1', retries = 0 }) {
    const url = `${this.env.api_url}/${version}${path}`;
    const headers = await this.buildHeaders(version);
    await this._delay(this.rateLimitDelay);

    try {
      const resp = await axios({ method, url, headers, params, data, timeout: this.timeout });
      return resp.data;
    } catch (err) {
      if (retries < this.maxRetries && this._isRetryable(err)) {
        await this._delay(1000 * (retries + 1));
        return this.request({ method, path, params, data, version, retries: retries + 1 });
      }
      throw this._normalizeError(err, url);
    }
  }

  _isRetryable(err) {
    if (!err.response) return true; // network error
    return [429, 500, 502, 503, 504].includes(err.response.status);
  }

  _normalizeError(err, url) {
    const e = new Error(err.response?.data?.message || err.message);
    e.status = err.response?.status;
    e.url = url;
    e.raw = err.response?.data;
    return e;
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Paginated fetch ───────────────────────────────────────────────────────

  async fetchAllPages({ path, version = 'v1', pageSize = 500, resultKey, params = {} }) {
    let page = 0;
    const all = [];
    while (true) {
      const resp = await this.request({
        path, version, params: { ...params, page, pagesize: pageSize }
      });
      const items = resultKey ? resp[resultKey] : (resp.List || resp.SearchResults || resp || []);
      if (!Array.isArray(items) || items.length === 0) break;
      all.push(...items);
      if (items.length < pageSize) break;
      page++;
    }
    return all;
  }

  // ── ORG GROUPS ────────────────────────────────────────────────────────────

  async getOrgGroups(rootOgId) {
    // Get all OGs under root
    return await this.fetchAllPages({
      path: `/system/groups/${rootOgId}/children`,
      version: 'v1',
      resultKey: 'OrganizationGroups',
    });
  }

  async getOrgGroupDetail(ogId) {
    return await this.request({ path: `/system/groups/${ogId}`, version: 'v1' });
  }

  async createOrgGroup(parentOgId, payload) {
    return await this.request({
      method: 'POST',
      path: `/system/groups/${parentOgId}`,
      version: 'v1',
      data: payload,
    });
  }

  async getRootOrgGroup() {
    return await this.request({ path: '/system/groups/0', version: 'v1' });
  }

  // ── PROFILES ──────────────────────────────────────────────────────────────

  async getProfiles(ogId) {
    return await this.fetchAllPages({
      path: '/mdm/profiles/search',
      version: 'v1',
      resultKey: 'SearchResults',
      params: { organizationgroupid: ogId },
    });
  }

  async getProfileDetail(profileId) {
    return await this.request({ path: `/mdm/profiles/${profileId}`, version: 'v1' });
  }

  async createProfile(payload) {
    return await this.request({ method: 'POST', path: '/mdm/profiles', version: 'v1', data: payload });
  }

  async updateProfile(profileId, payload) {
    return await this.request({ method: 'PUT', path: `/mdm/profiles/${profileId}`, version: 'v1', data: payload });
  }

  // ── APPLICATIONS (MAM) ────────────────────────────────────────────────────

  async getApplications(ogId) {
    const apps = [];
    // Internal apps
    const internal = await this.fetchAllPages({
      path: '/mam/apps/internal/search',
      version: 'v1',
      resultKey: 'Application',
      params: { organizationgroupid: ogId },
    });
    apps.push(...internal.map(a => ({ ...a, _appType: 'Internal' })));

    // Public apps
    const pub = await this.fetchAllPages({
      path: '/mam/apps/public/search',
      version: 'v1',
      resultKey: 'Application',
      params: { organizationgroupid: ogId },
    });
    apps.push(...pub.map(a => ({ ...a, _appType: 'Public' })));

    return apps;
  }

  async getAppDetail(appId, appType = 'internal') {
    return await this.request({ path: `/mam/apps/${appType}/${appId}`, version: 'v1' });
  }

  async createPublicApp(payload) {
    return await this.request({ method: 'POST', path: '/mam/apps/public', version: 'v1', data: payload });
  }

  async updateApp(appId, appType = 'internal', payload) {
    return await this.request({ method: 'PUT', path: `/mam/apps/${appType}/${appId}`, version: 'v1', data: payload });
  }

  // ── PRODUCTS ──────────────────────────────────────────────────────────────

  async getProducts(ogId) {
    return await this.fetchAllPages({
      path: '/mdm/products/search',
      version: 'v1',
      resultKey: 'ProductSearchResults',
      params: { organizationgroupid: ogId },
    });
  }

  async getProductDetail(productId) {
    return await this.request({ path: `/mdm/products/${productId}`, version: 'v2' });
  }

  async createProduct(payload) {
    return await this.request({ method: 'POST', path: '/mdm/products', version: 'v1', data: payload });
  }

  async updateProduct(productId, payload) {
    return await this.request({ method: 'PUT', path: `/mdm/products/${productId}`, version: 'v1', data: payload });
  }

  async activateProduct(productId) {
    return await this.request({ method: 'POST', path: `/mdm/products/${productId}/activate`, version: 'v1' });
  }

  // ── SMART GROUPS ──────────────────────────────────────────────────────────

  async getSmartGroups(ogId) {
    return await this.fetchAllPages({
      path: '/mdm/smartgroups/search',
      version: 'v1',
      resultKey: 'SmartGroups',
      params: { organizationgroupid: ogId },
    });
  }

  async getSmartGroupDetail(smartGroupId) {
    return await this.request({ path: `/mdm/smartgroups/${smartGroupId}`, version: 'v1' });
  }

  async createSmartGroup(payload) {
    return await this.request({ method: 'POST', path: '/mdm/smartgroups', version: 'v1', data: payload });
  }

  async updateSmartGroup(smartGroupId, payload) {
    return await this.request({ method: 'PUT', path: `/mdm/smartgroups/${smartGroupId}`, version: 'v1', data: payload });
  }

  // ── SENSORS ───────────────────────────────────────────────────────────────
  // Sensors use /mdm/devicesensors (UEM 2011+)

  async getSensors(ogUuid) {
    return await this.fetchAllPages({
      path: '/mdm/devicesensors/search',
      version: 'v1',
      resultKey: 'DeviceSensors',
      params: { organizationgroupuuid: ogUuid },
    });
  }

  async getSensorDetail(sensorUuid) {
    return await this.request({ path: `/mdm/devicesensors/${sensorUuid}`, version: 'v1' });
  }

  async createSensor(payload) {
    return await this.request({ method: 'POST', path: '/mdm/devicesensors', version: 'v1', data: payload });
  }

  async updateSensor(sensorUuid, payload) {
    return await this.request({ method: 'PUT', path: `/mdm/devicesensors/${sensorUuid}`, version: 'v1', data: payload });
  }

  // ── SCRIPTS ───────────────────────────────────────────────────────────────
  // Scripts use /mdm/scripts (UEM 2101+)

  async getScripts(ogUuid) {
    return await this.fetchAllPages({
      path: '/mdm/scripts/search',
      version: 'v1',
      resultKey: 'Scripts',
      params: { organizationgroupuuid: ogUuid },
    });
  }

  async getScriptDetail(scriptUuid) {
    return await this.request({ path: `/mdm/scripts/${scriptUuid}`, version: 'v1' });
  }

  async createScript(payload) {
    return await this.request({ method: 'POST', path: '/mdm/scripts', version: 'v1', data: payload });
  }

  async updateScript(scriptUuid, payload) {
    return await this.request({ method: 'PUT', path: `/mdm/scripts/${scriptUuid}`, version: 'v1', data: payload });
  }

  // ── Helpers: base64 encode/decode script/sensor bodies ───────────────────

  static decodeScriptBody(encoded) {
    if (!encoded) return null;
    try { return Buffer.from(encoded, 'base64').toString('utf8'); }
    catch { return encoded; }
  }

  static encodeScriptBody(plain) {
    if (!plain) return null;
    return Buffer.from(plain, 'utf8').toString('base64');
  }
}

/**
 * Factory: build a UEMClient from an environment record (by DB id)
 */
async function getClientForEnv(environmentId) {
  const result = await query('SELECT * FROM environments WHERE id = $1', [environmentId]);
  if (!result.rows.length) throw new Error(`Environment not found: ${environmentId}`);
  return new UEMClient(result.rows[0]);
}

module.exports = { UEMClient, getClientForEnv };
