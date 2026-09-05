#!/usr/bin/env node
import fs from 'node:fs';
const path = 'scripts/patch-story-cloud-image-handoff.mjs';
let source = fs.readFileSync(path, 'utf8');
const line = "  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`patch anchor not unique: ${label}`);\n";
if (!source.includes(line)) throw new Error('patcher uniqueness guard not found');
source = source.replace(line, '');
fs.writeFileSync(path, source);
