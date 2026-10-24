/**
 * Stable error vocabulary shared by the CLI, MCP server and DSH backend.
 */
export class HdsBaiduError extends Error {
  /**
   * @param {string} code Stable machine-readable code.
   * @param {string} message Safe human-readable message (must not contain tokens).
   * @param {{cause?: unknown, details?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HdsBaiduError'
    this.code = code
    this.details = options.details
  }
}

export class PathPolicyError extends HdsBaiduError {
  constructor(message, options = {}) {
    super('path-policy', message, options)
    this.name = 'PathPolicyError'
  }
}

export class BaiduApiError extends HdsBaiduError {
  /**
   * @param {string} method API method name.
   * @param {number|undefined} errno Baidu errno when present.
   * @param {string} message Safe message.
   * @param {{cause?: unknown, status?: number}} [options]
   */
  constructor(method, errno, message, options = {}) {
    super('baidu-api', `${method}: ${message}`, options)
    this.name = 'BaiduApiError'
    this.method = method
    this.errno = errno
    this.status = options.status
  }
}
