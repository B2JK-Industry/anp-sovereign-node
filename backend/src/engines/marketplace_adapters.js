class MarketplaceAdapter {
  constructor(options = {}) {
    this.endpoint = options.endpoint || null;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.headers = { ...(options.headers || {}) };
    this.acceptancePaths = Array.isArray(options.acceptancePaths)
      ? [...options.acceptancePaths]
      : [];
    this.label =
      options.label ||
      this.constructor.adapterLabel ||
      this.constructor.name.replace(/Adapter$/, "");

    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        `${this.label} adapter requires a fetch implementation (Node 18+ or custom fetchImpl).`
      );
    }
  }

  get name() {
    return this.label;
  }

  assertConfigured() {
    if (!this.endpoint) {
      throw new Error(`${this.name} adapter requires an endpoint.`);
    }
  }

  buildUrl(pathname = "", query = {}) {
    this.assertConfigured();

    const baseUrl = this.endpoint.endsWith("/")
      ? this.endpoint
      : `${this.endpoint}/`;
    const url = new URL(pathname.replace(/^\//, ""), baseUrl);

    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== "undefined" && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  async request(pathname, options = {}) {
    const url = this.buildUrl(pathname, options.query);
    const body = typeof options.body === "undefined"
      ? undefined
      : JSON.stringify(options.body);
    const headers = {
      Accept: "application/json",
      ...this.headers,
      ...(options.headers || {})
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await this.fetchImpl(url.toString(), {
      method: options.method || "GET",
      headers,
      body
    });
    const rawBody = await response.text();

    let data = rawBody;
    try {
      data = rawBody ? JSON.parse(rawBody) : null;
    } catch (error) {
      data = rawBody;
    }

    if (!response.ok) {
      throw new Error(
        `${this.name} request failed: ${response.status} ${response.statusText} ${rawBody}`
      );
    }

    return {
      url: url.toString(),
      status: response.status,
      data,
      headers: Object.fromEntries(response.headers.entries())
    };
  }

  async requestOptional(pathname, options = {}) {
    try {
      return await this.request(pathname, options);
    } catch (error) {
      if (
        /\b404\b/.test(error.message) ||
        /\b405\b/.test(error.message) ||
        /\b501\b/.test(error.message)
      ) {
        return null;
      }

      throw error;
    }
  }

  async fetchOpenListings() {
    throw new Error(`${this.name} adapter does not implement fetchOpenListings().`);
  }

  async publishDocument(document) {
    throw new Error(`${this.name} adapter does not implement publishDocument().`);
  }

  async fetchDocumentByCid() {
    return null;
  }

  async fetchAcceptancesForSigner() {
    return {
      adapter: this.name,
      endpoint: this.endpoint,
      status: null,
      url: null,
      body: null,
      documents: []
    };
  }
}

function extractListingsFromResponse(body) {
  if (Array.isArray(body)) {
    return body;
  }

  if (!body || typeof body !== "object") {
    return [];
  }

  const directKeys = ["listings", "items", "results", "data"];
  for (const key of directKeys) {
    if (Array.isArray(body[key])) {
      return body[key];
    }
  }

  if (body.data && typeof body.data === "object") {
    for (const key of directKeys) {
      if (Array.isArray(body.data[key])) {
        return body.data[key];
      }
    }
  }

  return [];
}

function extractDocumentsFromResponse(body) {
  if (Array.isArray(body)) {
    return body;
  }

  if (!body || typeof body !== "object") {
    return [];
  }

  const directKeys = ["documents", "items", "results", "data", "messages"];
  for (const key of directKeys) {
    if (Array.isArray(body[key])) {
      return body[key];
    }
  }

  if (body.data && typeof body.data === "object") {
    for (const key of directKeys) {
      if (Array.isArray(body.data[key])) {
        return body.data[key];
      }
    }
  }

  return [];
}

class HttpMarketplaceAdapter extends MarketplaceAdapter {
  static adapterLabel = "Marketplace";

  async fetchOpenListings() {
    const result = await this.request("listings", {
      query: {
        status: "open"
      }
    });

    return {
      adapter: this.name,
      endpoint: this.endpoint,
      status: result.status,
      url: result.url,
      body: result.data,
      listings: extractListingsFromResponse(result.data)
    };
  }

  async publishDocument(document) {
    const result = await this.request("publish", {
      method: "POST",
      body: document
    });

    return {
      adapter: this.name,
      endpoint: this.endpoint,
      status: result.status,
      url: result.url,
      body: result.data
    };
  }

  async fetchDocumentByCid(cid) {
    if (!cid) {
      return null;
    }

    const result = await this.requestOptional(`objects/${encodeURIComponent(String(cid))}`);
    if (!result) {
      return null;
    }

    return {
      adapter: this.name,
      endpoint: this.endpoint,
      status: result.status,
      url: result.url,
      body: result.data,
      headers: result.headers,
      document: result.data,
      contentCid: result.headers["x-content-cid"] || null
    };
  }

  async fetchAcceptancesForSigner(signer) {
    const candidateRequests = [
      {
        pathname: "acceptances",
        query: { signer }
      },
      {
        pathname: "documents",
        query: {
          type: "acceptance",
          signer
        }
      },
      {
        pathname: "documents",
        query: {
          type: "accept",
          signer
        }
      },
      ...this.acceptancePaths.map((pathname) => ({
        pathname,
        query: { signer }
      }))
    ];

    for (const candidate of candidateRequests) {
      const result = await this.requestOptional(candidate.pathname, {
        query: candidate.query
      });

      if (!result) {
        continue;
      }

      return {
        adapter: this.name,
        endpoint: this.endpoint,
        status: result.status,
        url: result.url,
        body: result.data,
        documents: extractDocumentsFromResponse(result.data)
      };
    }

    return {
      adapter: this.name,
      endpoint: this.endpoint,
      status: null,
      url: null,
      body: null,
      documents: []
    };
  }
}

module.exports = {
  MarketplaceAdapter,
  HttpMarketplaceAdapter,
  extractDocumentsFromResponse,
  extractListingsFromResponse
};
