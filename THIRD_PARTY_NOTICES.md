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

## RikkaHub chat background / floating UI

- Project: https://github.com/rikkahub/rikkahub
- Reused sources:
  - `app/src/main/java/me/rerere/rikkahub/service/ChatGenerationForegroundService.kt`
  - `app/src/main/java/me/rerere/rikkahub/ui/floating/ChatFloatingContent.kt` (floating bubble portion)
  - `app/src/main/java/me/rerere/rikkahub/ui/floating/ChatFloatingWindows.kt` (bubble FloatingX configuration)
  - `app/src/main/java/me/rerere/rikkahub/ui/components/ui/AppLogo.kt`
- License: GNU Affero General Public License v3.0
- SullyOS changes are limited to package/application integration, mapping SullyOS generation state onto RikkaHub's bubble state, SullyOS launcher resources, and compatibility with the SullyOS Android wrapper/toolchain.
- Full license text: `licenses/RikkaHub-AGPL-3.0.txt`
