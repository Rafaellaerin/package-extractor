// Web Worker for background extraction processing
// Prevents UI blocking on large packages

self.onmessage = async (event) => {
    const { type, data } = event.data;

    try {
        if (type === 'extract') {
            const result = await extractPackage(data.arrayBuffer, data.onProgress);
            self.postMessage({ type: 'complete', data: result, error: null });
        }
    } catch (error) {
        self.postMessage({
            type: 'complete',
            data: null,
            error: {
                message: error.message,
                code: error.code || 'UNKNOWN_ERROR'
            }
        });
    }
};

async function extractPackage(arrayBuffer, onProgress) {
    if (typeof fflate === 'undefined') {
        throw new Error('fflate library not available in worker');
    }

    try {
        const unzipped = fflate.gunzipSync(new Uint8Array(arrayBuffer));
        const files = parseTarball(unzipped, onProgress);
        return convert(files);
    } catch (error) {
        const err = new Error(`Extraction failed: ${error.message}`);
        err.code = 'EXTRACTION_ERROR';
        throw err;
    }
}

function parseTarball(data, onProgress) {
    const files = {};
    let offset = 0;
    let fileCount = 0;

    try {
        while (offset < data.length) {
            const header = data.slice(offset, offset + 512);
            if (header.length < 512) break;

            const nameBuffer = header.slice(0, 100);
            const name = new TextDecoder().decode(nameBuffer).replace(/\0/g, '').trim();
            const sizeBuffer = header.slice(124, 136);
            const sizeStr = new TextDecoder().decode(sizeBuffer).trim();
            const size = parseInt(sizeStr, 8);

            if (isNaN(size)) {
                console.warn(`Invalid size at offset ${offset}: ${sizeStr}`);
                break;
            }

            if (size < 0 || size > 1073741824) { // 1GB limit per file
                throw new Error(`Invalid file size: ${size} bytes (max 1GB)`);
            }

            if (size > 0) {
                files[name] = data.slice(offset + 512, offset + 512 + size);
            }

            offset += 512 + Math.ceil(size / 512) * 512;
            fileCount++;

            // Report progress every 100 files
            if (fileCount % 100 === 0 && onProgress) {
                self.postMessage({
                    type: 'progress',
                    data: {
                        filesProcessed: fileCount,
                        bytesProcessed: offset,
                        totalBytes: data.length,
                        percentage: Math.round((offset / data.length) * 100)
                    }
                });
            }
        }
    } catch (error) {
        const err = new Error(`Tarball parsing failed at offset ${offset}: ${error.message}`);
        err.code = 'TARBALL_PARSE_ERROR';
        throw err;
    }

    return files;
}

function convert(files) {
    const convertedFiles = {};
    const directories = Object.keys(files).filter(f => f.endsWith('/pathname'));

    try {
        for (const dir of directories) {
            const basePath = dir.replace('/pathname', '');
            const pathContent = new TextDecoder().decode(files[dir]);
            const newPath = pathContent.split('\n')[0].trim();

            if (!newPath) continue;

            const assetPath = `${basePath}/asset`;
            const metaPath1 = `${basePath}/asset.meta`;
            const metaPath2 = `${basePath}/metaData`;

            if (files[assetPath]) {
                convertedFiles[newPath] = files[assetPath];
            }
            if (files[metaPath1]) {
                convertedFiles[`${newPath}.meta`] = files[metaPath1];
            } else if (files[metaPath2]) {
                convertedFiles[`${newPath}.meta`] = files[metaPath2];
            }
        }
    } catch (error) {
        const err = new Error(`File conversion failed: ${error.message}`);
        err.code = 'CONVERSION_ERROR';
        throw err;
    }

    return convertedFiles;
}
