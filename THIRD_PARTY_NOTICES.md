# Third-Party Notices

SullyOS includes or links to third-party software that remains under its own license.

## FloatingX

- Project: https://github.com/Petterpx/FloatingX
- Version used by the Android floating-generation feature: 3.0.0
- License: MIT
- Copyright (c) 2021 Petterp

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## RikkaHub ChatGenerationForegroundService

- Project: https://github.com/rikkahub/rikkahub
- Source reused: `app/src/main/java/me/rerere/rikkahub/service/ChatGenerationForegroundService.kt`
- License: GNU Affero General Public License v3.0
- SullyOS changes: package/application integration, String generation IDs, notification resources, and removal of the Android 15 `onTimeout` hook because the current SullyOS Android toolchain compiles against an older SDK.
- Full license text: `licenses/RikkaHub-AGPL-3.0.txt`
