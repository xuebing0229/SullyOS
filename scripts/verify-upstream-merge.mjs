import {
    access,
    readFile,
    readdir,
} from 'node:fs/promises';
import {
    constants as fsConstants,
} from 'node:fs';
import path from 'node:path';
import {
    execFileSync,
} from 'node:child_process';

const root = process.cwd();
const errors = [];
const warnings = [];

const rel = file => path.join(root, file);

async function exists(file) {
    try {
        await access(rel(file), fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function text(file) {
    return readFile(rel(file), 'utf8');
}

function fail(message) {
    errors.push(message);
}

function warn(message) {
    warnings.push(message);
}

async function requireFile(file) {
    if (!(await exists(file))) {
        fail(`缺少文件：${file}`);
    }
}

async function requireContains(file, patterns) {
    if (!(await exists(file))) {
        fail(`缺少文件：${file}`);
        return;
    }
    const source = await text(file);
    for (const pattern of patterns) {
        if (!source.includes(pattern)) {
            fail(`${file} 缺少不变量：${pattern}`);
        }
    }
}

async function requireNotContains(file, patterns) {
    if (!(await exists(file))) return;
    const source = await text(file);
    for (const pattern of patterns) {
        if (source.includes(pattern)) {
            fail(`${file} 仍包含禁用旧逻辑：${pattern}`);
        }
    }
}

async function walk(dir) {
    const out = [];
    const entries = await readdir(dir, {
        withFileTypes: true,
    });
    for (const entry of entries) {
        if ([
            '.git',
            'node_modules',
            'dist',
            'android',
            '.vite',
        ].includes(entry.name)) continue;

        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...await walk(full));
        } else {
            out.push(full);
        }
    }
    return out;
}

function currentBranch() {
    try {
        return execFileSync(
            'git',
            ['rev-parse', '--abbrev-ref', 'HEAD'],
            {
                cwd: root,
                encoding: 'utf8',
            },
        ).trim();
    } catch {
        return '';
    }
}

const branch = currentBranch();
if (!branch) {
    warn('无法读取当前 Git 分支');
} else if (branch === 'master') {
    fail(
        '当前在 master。必须从 '
        + 'test/integration-pr7-pr8-pr9-pr10 '
        + '派生临时合并分支，禁止直接改 master。',
    );
}

await requireFile('utils/aiCompletionPipeline.ts');
await requireFile('utils/aiCompletionPipeline.test.ts');

await requireContains('utils/db.ts', [
    'const DB_VERSION = 76',
    "STORE_AI_RESPONSE_CACHE = 'ai_response_cache'",
    "STORE_API_COST_DAILY = 'api_cost_daily'",
    'cleanupLegacyTurnContextSnapshots',
    'appendApiCallLog',
]);

await requireContains('utils/aiRequestManager.ts', [
    'STORE_AI_RESPONSE_CACHE',
    'runAiRequest',
    'cleanupAiCache',
]);

await requireContains('utils/aiCompletionPipeline.ts', [
    'executeCachedChatCompletion',
    'executeCachedEmotionCompletion',
    'executeOpenAiChatPlan',
    'shouldPersistChatCompletion',
]);

await requireContains('hooks/useChatAI.ts', [
    'executeCachedChatCompletion',
    'executeCachedEmotionCompletion',
    'persistMcpGeneratedImages',
    'createMcpTurnExecutionState',
    'buildEmotionUserReferenceSection',
]);

await requireContains('utils/apiCallLog.ts', [
    'failoverPresetId',
    'costMicros',
    'networkRequest',
    'requestHash',
]);

await requireContains('utils/chatResponseCachePolicy.ts', [
    'CHAT_RESPONSE_CACHE_VERSION',
    'shouldPersistChatCompletion',
]);

await requireContains('utils/apiFailover.ts', [
    'executeOpenAiChatPlan',
    'runApiFailover',
    'failoverPresetId',
]);

await requireContains('utils/mcpExecutionPolicy.ts', [
    'createMcpTurnExecutionState',
    'claimMcpToolExecution',
    'single-shot',
]);

await requireContains('utils/mcpImagePersistence.ts', [
    'persistMcpGeneratedImages',
    'saveGeneratedImageBundle',
    'MAX_MCP_IMAGE_BYTES',
]);

await requireFile(
    'components/character/NovelAiReferenceSettings.tsx',
);
await requireFile(
    'components/settings/ImageGenerationSettings.tsx',
);
await requireFile('utils/backgroundImageJobs.ts');
await requireFile('utils/apiPricing.ts');
await requireFile('utils/apiFailover.ts');
await requireFile('utils/vrWorld/roomSelection.ts');

/* 上游 6c07fdef 必须存在的主要新功能。 */
await requireFile('components/chat/MemoryRepairPortal.tsx');
await requireFile('utils/memoryPalace/externalMemory.ts');
await requireFile('utils/memoryPalace/memoryRepair.ts');
await requireFile(
    'components/schedule/ScheduleAppearanceButton.tsx',
);
await requireFile('utils/scheduleAppearance.ts');
await requireFile('utils/transferFormat.ts');
await requireFile('utils/toolCallCompat.ts');
await requireFile('utils/promptMessageCleanup.ts');

await requireContains('context/OSContext.tsx', [
    'writeV2Backup',
    'assembleV2Backup',
    'onLegacyTurnContextCleaned',
    '__sullyApiCallId',
]);

await requireNotContains('hooks/useChatAI.ts', [
    'appendTurnContext',
    'currentTurnContext',
]);

await requireNotContains('utils/chatRequestPayload.ts', [
    'appendTurnContext',
    'currentTurnContext',
]);

await requireNotContains('utils/chatPrompts.ts', [
    'appendTurnContext',
]);

/* DB 版本不能被上游的 v68 覆盖。 */
if (await exists('utils/db.ts')) {
    const db = await text('utils/db.ts');
    const match = db.match(
        /const\s+DB_VERSION\s*=\s*(\d+)/,
    );
    if (!match) {
        fail('utils/db.ts 无法解析 DB_VERSION');
    } else if (Number(match[1]) < 70) {
        fail(
            `DB_VERSION=${match[1]}，不得低于整合线 v70`,
        );
    }
}

/* 检查所有常见文本文件里是否残留冲突标记。 */
const files = await walk(root);
const textExtensions = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.mjs',
    '.json',
    '.yml',
    '.yaml',
    '.md',
    '.css',
]);

for (const file of files) {
    if (!textExtensions.has(path.extname(file))) continue;
    let source;
    try {
        source = await readFile(file, 'utf8');
    } catch {
        continue;
    }
    if (
        /^<<<<<<< /m.test(source)
        || /^=======$/m.test(source)
        || /^>>>>>>> /m.test(source)
    ) {
        fail(
            `存在未解决 Git 冲突：${
                path.relative(root, file)
            }`,
        );
    }
}

if (warnings.length) {
    console.warn('\n警告：');
    for (const item of warnings) {
        console.warn(`- ${item}`);
    }
}

if (errors.length) {
    console.error('\n上游合并不变量检查失败：');
    for (const item of errors) {
        console.error(`- ${item}`);
    }
    process.exit(1);
}

console.log(
    '\n✅ SullyOS 上游合并关键不变量全部通过',
);
