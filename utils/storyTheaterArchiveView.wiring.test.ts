import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
const source=readFileSync(new URL('../components/date/story/StoryTheaterSession.tsx',import.meta.url),'utf8');
const history=readFileSync(new URL('../components/date/story/StoryHistoryPreview.tsx',import.meta.url),'utf8');
it('keeps archived story prose searchable and accessible from a single history entry',()=>{
 expect(source).toContain('StoryHistoryPreview');
 expect(source).toContain('pendingHistoryJumpRef');
 expect(source).toContain('setShowHistoryPreview(true)');
 expect(history).toContain('onJump');
});
it('keeps continuous story scrolling and complete export beside the reading appearance',()=>{
 expect(source).toContain("useState<'continuous' | 'pages'>('continuous')");
 expect(source).toContain('visibleMessages.map(message');
 expect(source).toContain('ResizeObserver');
 expect(source).toContain('exportStory');
 expect(source).toContain("readingMode === 'pages'");
 expect(source).toContain('StoryPagination');
 expect(source).toContain('togglePageArchives');
 expect(source).toContain('setMessagePage(Math.floor(index / STORY_PAGE_SIZE))');
});
