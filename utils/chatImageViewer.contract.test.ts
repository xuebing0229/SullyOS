import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
    fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('chat image fullscreen viewer contract', () => {
    it('opens ordinary image messages through the shared viewer', () => {
        const source = read('components/chat/MessageItem.tsx');
        expect(source).toContain('openChatImageViewer');
        expect(source).toContain("if (m.type === 'image')");
        expect(source).toContain('aria-label="查看大图"');
        expect(source).toContain('suppressNextClickRef');
    });

    it('mounts one global host inside OSProvider', () => {
        const source = read('App.tsx');
        expect(source).toContain('ChatImageViewerHost');
        const providerStart = source.indexOf('<OSProvider>');
        const host = source.indexOf('<ChatImageViewerHost />');
        const providerEnd = source.indexOf('</OSProvider>');
        expect(providerStart).toBeGreaterThanOrEqual(0);
        expect(host).toBeGreaterThan(providerStart);
        expect(host).toBeLessThan(providerEnd);
    });

    it('reuses BlobImage and closes on Android back or background click', () => {
        const source = read('components/media/ChatImageViewerHost.tsx');
        expect(source).toContain('<BlobImage');
        expect(source).toContain('registerBackHandler');
        expect(source).toContain('fixed inset-0');
        expect(source).toContain('onClick={close}');
        expect(source).toContain('event.stopPropagation()');
    });

    it('preserves the previous app back handler after the overlay unregisters', () => {
        const source = read('context/OSContext.tsx');
        expect(source).toContain('backHandlerStackRef');
        expect(source).toContain('stack.push(handler)');
        expect(source).toContain('stack.splice(index, 1)');
        expect(source).toContain('for (let index = stack.length - 1; index >= 0; index -= 1)');
    });

    it('does not navigate, open a browser page, or add persistent state', () => {
        const host = read('components/media/ChatImageViewerHost.tsx');
        const bridge = read('utils/chatImageViewer.ts');
        expect(host).not.toContain('openApp(');
        expect(host).not.toContain('window.open(');
        expect(bridge).not.toContain('localStorage');
        expect(bridge).not.toContain('indexedDB');
    });
});
