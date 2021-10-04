/*
 * noVNC: HTML5 VNC client
 * Copyright (C) 2019 The noVNC Authors
 * Licensed under MPL 2.0 (see LICENSE.txt)
 *
 * See README.md for usage and integration instructions.
 *
 */
import Inflator from "../inflator.js";

export default class ZRLEDecoder {
    constructor() {
        this._data = false;
        this._compressedLength = null;
        this._uncompressed = null;
        this._tileBuffer = new Uint8ClampedArray(64 * 64 * 4);
        this._zlib = new Inflator();
        this._clearDataBuffer();
        this._bpp = 24;
    }

    _clearDataBuffer() {
        this._dataBuffer = null;
        this._dataBufferPtr = 0;
        this._dataBufferSize = 1 + (1024 * 10);
    }

    _fillDataBuffer() {
        let fillSize = this._dataBufferSize;
        while (true) {
            try {
                this._dataBuffer = this._zlib.inflate(fillSize, true);
                this._dataBufferPtr = 0;
                this._dataBufferSize = this._dataBuffer.length;
                break;
            } catch (e) {
                if (fillSize == 1) { // Something's wrong if we can't fill even 1 byte
                    throw (e);
                }
                fillSize = Math.ceil(fillSize / 2);
            }
        }
    }

    _inflateFromStream(bytes) {
        if (this._dataBuffer == null) {
            this._dataBuffer = new Uint8Array(this._dataBufferSize);
            this._fillDataBuffer();
        }
        let ret = new Uint8Array(bytes), pos = 0;
        while (bytes > 0) {
            let sliceLen = bytes > (this._dataBufferSize - this._dataBufferPtr) ? this._dataBufferSize - this._dataBufferPtr : bytes;
            ret.set(this._dataBuffer.slice(this._dataBufferPtr, this._dataBufferPtr + sliceLen), pos);
            pos += sliceLen;
            this._dataBufferPtr += sliceLen;
            bytes -= sliceLen;
            if (bytes > 0 && this._dataBufferPtr == this._dataBufferSize) {
                this._fillDataBuffer();
                this._dataBufferPtr = 0;
            }
        }
        return ret;
    }

    _rleRun() {
        let r = 0, runLength = 1;
        do {
            r = this._inflateFromStream(1)[0];
            runLength += r;
        } while (r == 255);
        return runLength;
    }

    _blitTile(blitpos, blitlen, color, display) {
        let bp = blitpos * 4;
        let ep = bp + (blitlen * 4);
        let p = bp;
        switch (this._bpp) {
            case 2:
                color = display.rgb565To888([color[0], color[1]]);
                for (; p < ep;) {
                    this._tileBuffer[p] = color[0];
                    this._tileBuffer[p + 1] = color[1];
                    this._tileBuffer[p + 2] = color[2];
                    this._tileBuffer[p + 3] = 255;
                    p += 4;
                }
                break;
            case 3:
                for (; p < ep;) {
                    this._tileBuffer[p] = color[0];
                    this._tileBuffer[p + 1] = color[1];
                    this._tileBuffer[p + 2] = color[2];
                    this._tileBuffer[p + 3] = 255;
                    p += 4;
                }
                break;
        }
    }

    _colorFromPalette(palette, index, bpp) {
        let idx = bpp * index;
        switch (this._bpp) {
            case 2:
                return [palette[idx], palette[idx + 1]];
            case 3:
                return [palette[idx], palette[idx + 1], palette[idx + 2]];
        }
    }

    _testBit(cb, bit) {
        return (cb & (1 << bit)) === 0 ? 0 : 1;
    }

    decodeRect(x, y, width, height, sock, display, depth, bpp) {
        if (this._compressedLength === null) {
            this._clearDataBuffer();

            // Wait for compressed data length
            if (sock.rQwait("ZRLE", 4)) {
                return false;
            }
            this._compressedLength = sock.rQshift32();
            if (this._compressedLength < this._dataBufferSize) {
                // Try to choose a better data buffer size in powers of 2
                this._dataBufferSize = 1 + Math.pow(2, Math.floor(Math.log(this._compressedLength) / Math.log(2)));
            }
        }
        if (this._compressedLength !== null && this._data === false) {
            // Wait for compressed data
            if (sock.rQwait("ZRLE", this._compressedLength)) {
                return false;
            }
            this._data = true;
            let data = sock.rQshiftBytes(this._compressedLength);
            this._zlib.setInput(data);
        }
        if (this._data === true) {
            this._bpp = (bpp / 8) > 3 ? 3 : Math.round(bpp / 8);
            let totalTilesX = Math.ceil(width / 64);
            let totalTilesY = Math.ceil(height / 64);
            let rx = 0, ry = 0;
            for (let ty = 1; ty <= totalTilesY; ty++) {
                rx = 0;
                for (let tx = 1; tx <= totalTilesX; tx++) {
                    let tileWidth = (tx == totalTilesX) ? width - ((totalTilesX - 1) * 64) : 64;
                    let tileHeight = (ty == totalTilesY) ? height - ((totalTilesY - 1) * 64) : 64;
                    let tileTotalPixels = tileWidth * tileHeight;
                    let px = x + rx, py = y + ry;

                    let subencoding = this._inflateFromStream(1)[0];
                    if (subencoding == 0) { // Raw pixel data
                        let bytes = tileWidth * tileHeight * this._bpp;
                        let data = this._inflateFromStream(bytes);
                        for (let src = 0, dst = 0; src < bytes; src += this._bpp, dst += 4) {
                            let color;
                            switch (this._bpp) {
                                case 2:
                                    color = display.rgb565To888([data[src], data[src + 1]]);
                                    this._tileBuffer[dst] = color[0];
                                    this._tileBuffer[dst + 1] = color[1];
                                    this._tileBuffer[dst + 2] = color[2];
                                    this._tileBuffer[dst + 3] = 255;
                                    break;
                                case 3:
                                    this._tileBuffer[dst] = data[src];
                                    this._tileBuffer[dst + 1] = data[src + 1];
                                    this._tileBuffer[dst + 2] = data[src + 2];
                                    this._tileBuffer[dst + 3] = 255;
                                    break;
                            }
                        }
                        display.blitImage(px, py, tileWidth, tileHeight, this._tileBuffer, 0, false);
                    }
                    if (subencoding == 1) { // Solid tile (single color)
                        let pixel = this._inflateFromStream(this._bpp), color;
                        switch (this._bpp) {
                            case 2:
                                color = display.rgb565To888([pixel[0], pixel[1]]);
                                display.fillRect(px, py, tileWidth, tileHeight, [color[0], color[1], color[2]], false);
                                break;
                            case 3:
                                display.fillRect(px, py, tileWidth, tileHeight, [pixel[0], pixel[1], pixel[2]], false);
                                break;
                        }
                    }
                    if (subencoding >= 2 && subencoding <= 16) { // Packed palette
                        let bytes = subencoding * this._bpp;
                        let paletteData = this._inflateFromStream(bytes);
                        let packedPixelBytes, bitsPerPixel, pixelsPerByte;
                        switch (subencoding) {
                            case 2:
                                packedPixelBytes = Math.floor((tileWidth + 7) / 8) * tileHeight;
                                bitsPerPixel = 1;
                                pixelsPerByte = 8;
                                break;
                            case 3:
                            case 4:
                                packedPixelBytes = Math.floor((tileWidth + 3) / 4) * tileHeight;
                                bitsPerPixel = 2;
                                pixelsPerByte = 4;
                                break;
                            default:
                                packedPixelBytes = Math.floor((tileWidth + 1) / 2) * tileHeight;
                                bitsPerPixel = 4;
                                pixelsPerByte = 2;
                                break;
                        }
                        let strideWidth = (Math.ceil(tileWidth / 8) * 8) / pixelsPerByte;
                        let pixelData = this._inflateFromStream(packedPixelBytes), pixel = 0, tilePos = 0, cb = pixelData[0];
                        for (let tileY = 0; tileY < tileHeight; tileY++) {
                            cb = pixelData[strideWidth * tileY];
                            for (let tileX = 0, bitIdx = 0, byteIdx = strideWidth * tileY; tileX < tileWidth; tileX++) {
                                switch (bitsPerPixel) {
                                    case 1:
                                        pixel = this._testBit(cb, 8 - bitIdx);
                                        bitIdx++;
                                        break;
                                    case 2:
                                        pixel = (this._testBit(cb, 6 - bitIdx))
                                            + (this._testBit(cb, 7 - bitIdx) << 1);
                                        bitIdx += 2;
                                        break;
                                    case 4:
                                        pixel = this._testBit(cb, 4 - bitIdx)
                                            + (this._testBit(cb, 5 - bitIdx) << 1)
                                            + (this._testBit(cb, 6 - bitIdx) << 2)
                                            + (this._testBit(cb, 7 - bitIdx) << 3);
                                        bitIdx += 4;
                                        break;
                                }
                                if (bitIdx == 8) {
                                    byteIdx += 1;
                                    cb = pixelData[byteIdx];
                                    bitIdx = 0;
                                }
                                let color;
                                switch (this._bpp) {
                                    case 2:
                                        color = display.rgb565To888([paletteData[pixel * this._bpp], paletteData[pixel * this._bpp + 1]]);
                                        this._blitTile(tilePos, 1, color, display);
                                        break;
                                    case 3:
                                        this._blitTile(tilePos, 1, [paletteData[pixel * this._bpp], paletteData[pixel * this._bpp + 1], paletteData[pixel * this._bpp + 2]], display);
                                        break;
                                }
                                tilePos++;
                            }
                        }
                        display.blitImage(px, py, tileWidth, tileHeight, this._tileBuffer, 0, false);
                    }
                    if (subencoding == 128) { // Plain RLE
                        let tilePos = 0;
                        while (tilePos < tileTotalPixels) {
                            let pixel = this._inflateFromStream(this._bpp);
                            let runLength = this._rleRun();
                            this._blitTile(tilePos, runLength, pixel, display);
                            tilePos += runLength;
                        }
                        display.blitImage(px, py, tileWidth, tileHeight, this._tileBuffer, 0, false);
                    }
                    if (subencoding >= 130) { // Palette RLE
                        let paletteBytes = (subencoding - 128) * this._bpp;
                        let palette = this._inflateFromStream(paletteBytes);
                        let tilePos = 0;
                        while (tilePos < tileTotalPixels) {
                            let paletteIndex = this._inflateFromStream(1)[0];
                            let runLength = 1;
                            if (paletteIndex > 127) {
                                let color = this._colorFromPalette(palette, paletteIndex - 128, this._bpp);
                                runLength = this._rleRun();
                                this._blitTile(tilePos, runLength, color, display);
                            } else {
                                let color = this._colorFromPalette(palette, paletteIndex, this._bpp);
                                this._blitTile(tilePos, runLength, color, display);
                            }
                            tilePos += runLength;
                        }
                        display.blitImage(px, py, tileWidth, tileHeight, this._tileBuffer, 0, false);
                    }
                    rx += 64; // next tile
                }
                ry += 64; // next row
            }
            this._zlib.setInput(null);
            this._compressedLength = null;
            this._data = false;
        }
        return true;
    }

}
