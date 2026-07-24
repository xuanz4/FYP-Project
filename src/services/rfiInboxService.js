const tls = require('tls');
const emailService = require('./emailService');

function quoteImap(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseInboxConfig(env = process.env) {
  const user = String(env.IMAP_USER || env.SMTP_USER || '').trim();
  const pass = String(env.IMAP_PASS || env.SMTP_PASS || '');
  const host = String(env.IMAP_HOST || (/@gmail\.com$/i.test(user) ? 'imap.gmail.com' : '')).trim();
  const port = Number(env.IMAP_PORT || 993);
  const mailbox = String(env.IMAP_MAILBOX || 'INBOX').trim();
  const from = emailService.parseMailbox(env.SMTP_FROM || user);

  if (!host || !user || !pass || !mailbox) {
    const error = new Error('IMAP inbox access is not configured. Set IMAP_HOST/IMAP_USER/IMAP_PASS, or use Gmail SMTP_USER/SMTP_PASS.');
    error.code = 'EMISSINGIMAPCONFIG';
    throw error;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error('IMAP_PORT must be a whole number from 1 to 65535');
    error.code = 'EINVALIDIMAPCONFIG';
    throw error;
  }

  return {
    host,
    port,
    user,
    pass,
    mailbox,
    account: from?.address || user,
  };
}

function connectImap(config, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: config.host,
      port: config.port,
      servername: config.host,
      timeout: timeoutMs,
    });
    socket.setEncoding('utf8');

    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) {
        settled = true;
        const error = new Error('Timed out connecting to the IMAP inbox.');
        error.code = 'EIMAPTIMEOUT';
        reject(error);
      }
    }, timeoutMs);

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!settled && /\* OK/i.test(buffer)) {
        clearTimeout(timer);
        settled = true;
        resolve(socket);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function sendCommand(socket, tag, command, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let response = '';
    const timer = setTimeout(() => {
      cleanup();
      const error = new Error(`Timed out waiting for IMAP command ${tag}.`);
      error.code = 'EIMAPTIMEOUT';
      reject(error);
    }, timeoutMs);

    const onData = (chunk) => {
      response += chunk;
      if (new RegExp(`\\r?\\n${tag} (OK|NO|BAD)`, 'i').test(response)) {
        cleanup();
        if (new RegExp(`\\r?\\n${tag} OK`, 'i').test(response)) {
          resolve(response);
        } else {
          const error = new Error(`IMAP command failed: ${command}`);
          error.code = 'EIMAPCOMMANDFAILED';
          error.response = response;
          reject(error);
        }
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };

    socket.on('data', onData);
    socket.on('error', onError);
    socket.write(`${tag} ${command}\r\n`);
  });
}

function extractFetchedRawMessage(response) {
  const literalMatch = response.match(/\{(\d+)\}\r?\n/);
  if (!literalMatch) return '';
  const start = literalMatch.index + literalMatch[0].length;
  return response.slice(start, start + Number(literalMatch[1]));
}

function parseHeaders(raw) {
  const [headerText] = String(raw || '').split(/\r?\n\r?\n/, 1);
  const headers = {};
  let current = null;
  for (const line of headerText.split(/\r?\n/)) {
    if (/^\s/.test(line) && current) {
      headers[current] += ` ${line.trim()}`;
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    current = line.slice(0, separator).toLowerCase();
    headers[current] = line.slice(separator + 1).trim();
  }
  return headers;
}

function decodeEncodedWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (_, charset, encoding, text) => {
    const normalized = encoding.toLowerCase() === 'b'
      ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary');
    return normalized.toString(/utf-?8/i.test(charset) ? 'utf8' : 'latin1');
  });
}

function decodeQuotedPrintable(value) {
  return String(value || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodePart(body, headers) {
  const transferEncoding = String(headers['content-transfer-encoding'] || '').toLowerCase();
  if (transferEncoding.includes('base64')) {
    return Buffer.from(String(body || '').replace(/\s+/g, ''), 'base64').toString('utf8');
  }
  if (transferEncoding.includes('quoted-printable')) {
    return decodeQuotedPrintable(body);
  }
  return String(body || '');
}

function extractTextBody(raw) {
  const [, ...bodyParts] = String(raw || '').split(/\r?\n\r?\n/);
  const body = bodyParts.join('\n\n');
  const headers = parseHeaders(raw);
  const contentType = String(headers['content-type'] || '').toLowerCase();
  const boundary = (headers['content-type'] || '').match(/boundary="?([^";]+)"?/i)?.[1];

  if (contentType.includes('multipart/') && boundary) {
    const parts = body.split(`--${boundary}`);
    const textPart = parts.find((part) => /content-type:\s*text\/plain/i.test(part))
      || parts.find((part) => /content-type:\s*text\/html/i.test(part));
    if (textPart) {
      const partHeaders = parseHeaders(textPart);
      const [, ...partBodyParts] = textPart.split(/\r?\n\r?\n/);
      const decoded = decodePart(partBodyParts.join('\n\n'), partHeaders);
      return /text\/html/i.test(partHeaders['content-type'] || '')
        ? decoded.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+\n/g, '\n').trim()
        : decoded.trim();
    }
  }

  return decodePart(body, headers).trim();
}

function parseEmailMessage(raw) {
  const headers = parseHeaders(raw);
  return {
    from: decodeEncodedWords(headers.from || ''),
    to: decodeEncodedWords(headers.to || ''),
    subject: decodeEncodedWords(headers.subject || ''),
    date: headers.date || '',
    // Exposed for case_rfi_evidence.mailbox_reference (see rfiEvidence.js) - lets an evidence
    // log entry point at a specific, independently re-checkable message instead of just text.
    messageId: headers['message-id'] || '',
    inReplyTo: headers['in-reply-to'] || '',
    references: headers.references || '',
    text: extractTextBody(raw).replace(/\r/g, '').trim(),
  };
}

async function fetchLatestRfiResponse({ transactionId, env = process.env } = {}) {
  const config = parseInboxConfig(env);
  const query = String(transactionId || '').trim();
  if (!query) return { found: false, account: config.account, message: null };

  const socket = await connectImap(config);
  try {
    await sendCommand(socket, 'A1', `LOGIN ${quoteImap(config.user)} ${quoteImap(config.pass)}`);
    await sendCommand(socket, 'A2', `SELECT ${quoteImap(config.mailbox)}`);
    const searchResponse = await sendCommand(socket, 'A3', `SEARCH TEXT ${quoteImap(query)}`);
    const ids = (searchResponse.match(/\* SEARCH ([^\r\n]*)/i)?.[1] || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter(Number.isFinite);
    if (!ids.length) {
      return { found: false, account: config.account, message: null };
    }

    const latestId = Math.max(...ids);
    const fetchResponse = await sendCommand(socket, 'A4', `FETCH ${latestId} BODY.PEEK[]`);
    const raw = extractFetchedRawMessage(fetchResponse);
    return {
      found: true,
      account: config.account,
      message: {
        id: latestId,
        ...parseEmailMessage(raw),
      },
    };
  } finally {
    socket.write('A9 LOGOUT\r\n');
    socket.end();
  }
}

module.exports = {
  fetchLatestRfiResponse,
  parseEmailMessage,
  parseInboxConfig,
};
