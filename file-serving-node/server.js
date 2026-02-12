const http = require('http');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_UPLOAD_DIR = process.env.RENDER ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');
const UPLOAD_DIR = process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.txt']);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function send(res, statusCode, contentType, body) {
    res.writeHead(statusCode, { 'Content-Type': contentType });
    res.end(body);
}

function safeJoin(baseDir, urlPath) {
    const cleanPath = decodeURIComponent(urlPath.split('?')[0]).split('#')[0];
    const relative = cleanPath.replace(/^\/+/, '');
    const absPath = path.join(baseDir, relative);
    const safeRoot = baseDir + path.sep;
    if (!absPath.startsWith(safeRoot)) return null;
    return absPath;
}

function serveFile(filePath, res) {
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                return send(res, 404, 'text/html', '<h1>404 - File Not Found</h1>');
            }
            return send(res, 500, 'text/plain', `Server Error: ${err.code}`);
        }
        const contentType = mime.lookup(filePath) || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    });
}

function splitBuffer(buffer, separator) {
    const parts = [];
    let start = 0;
    let index = buffer.indexOf(separator, start);
    while (index !== -1) {
        parts.push(buffer.slice(start, index));
        start = index + separator.length;
        index = buffer.indexOf(separator, start);
    }
    parts.push(buffer.slice(start));
    return parts;
}

function parseMultipart(buffer, boundary) {
    const boundaryBuffer = Buffer.from(`--${boundary}`);
    const chunks = splitBuffer(buffer, boundaryBuffer);
    return chunks
        .map(part => part.slice(2, part.length - 2))
        .filter(part => part.length > 0);
}

function handleUpload(req, res) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
        return send(res, 400, 'text/plain', 'Invalid form encoding');
    }

    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
        return send(res, 400, 'text/plain', 'Missing boundary');
    }
    const boundary = boundaryMatch[1];

    let totalBytes = 0;
    const chunks = [];

    req.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_UPLOAD_BYTES) {
            req.destroy();
            return send(res, 413, 'text/plain', 'File too large');
        }
        chunks.push(chunk);
    });

    req.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const parts = parseMultipart(bodyBuffer, boundary);
        let savedFile = null;

        for (const part of parts) {
            const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
            if (headerEnd === -1) continue;
            const headerText = part.slice(0, headerEnd).toString('utf8');
            const data = part.slice(headerEnd + 4);
            const dispositionMatch = headerText.match(/content-disposition:.*name="([^"]+)"(?:; filename="([^"]+)")?/i);
            if (!dispositionMatch) continue;
            const fieldName = dispositionMatch[1];
            const fileNameRaw = dispositionMatch[2];
            if (fieldName !== 'file' || !fileNameRaw) continue;

            const safeName = path.basename(fileNameRaw);
            const ext = path.extname(safeName).toLowerCase();
            if (!ALLOWED_EXTENSIONS.has(ext)) {
                return send(res, 415, 'text/plain', 'File type not allowed');
            }

            const finalName = `${Date.now()}-${safeName}`;
            const targetPath = path.join(UPLOAD_DIR, finalName);
            fs.writeFileSync(targetPath, data);
            savedFile = finalName;
            break;
        }

        if (!savedFile) {
            return send(res, 400, 'text/plain', 'No file uploaded');
        }

        const link = `/uploads/${encodeURIComponent(savedFile)}`;
        send(res, 200, 'text/html', `<h1>Upload complete</h1><p><a href="${link}">View file</a></p>`);
    });

    req.on('error', () => {
        send(res, 500, 'text/plain', 'Upload failed');
    });
}

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/upload') {
        return handleUpload(req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'text/plain', 'Method Not Allowed');
    }

    if (req.url === '/' || req.url === '/index.html') {
        return serveFile(path.join(PUBLIC_DIR, 'index.html'), res);
    }

    if (req.url.startsWith('/uploads/')) {
        const uploadPath = safeJoin(UPLOAD_DIR, req.url.replace('/uploads/', ''));
        if (!uploadPath) return send(res, 403, 'text/plain', 'Forbidden');
        return serveFile(uploadPath, res);
    }

    const filePath = safeJoin(PUBLIC_DIR, req.url);
    if (!filePath) return send(res, 403, 'text/plain', 'Forbidden');
    return serveFile(filePath, res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
