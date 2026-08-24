# Third-Party Notices

## @steipete/sweet-cookie 0.4.1

License: MIT

Copyright (c) 2025 Peter Steinberger

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

## Bun 1.3.6 Runtime

The compiled cookie helper contains the Bun standalone runtime from commit
`d530ed993d62be7c7f8f01a3d52627b6845dfd93`.

License: MIT for Bun itself. Bun's complete upstream license and linked-library
inventory for this exact version is available at:

https://github.com/oven-sh/bun/blob/d530ed993d62be7c7f8f01a3d52627b6845dfd93/LICENSE.md

Source code for this exact version is available at:

https://github.com/oven-sh/bun/tree/d530ed993d62be7c7f8f01a3d52627b6845dfd93

## JavaScriptCore And WebKit In Bun 1.3.6

Bun 1.3.6 statically links JavaScriptCore and WebKit. Bun identifies these
components as licensed under the GNU Library General Public License, version 2.
The WebKit revision pinned by Bun 1.3.6 is
`1d0216219a3c52cb85195f48f19ba7d5db747ff7`.

Exact source code:

https://github.com/oven-sh/WebKit/tree/1d0216219a3c52cb85195f48f19ba7d5db747ff7

GNU Library General Public License, version 2:

https://github.com/oven-sh/WebKit/blob/1d0216219a3c52cb85195f48f19ba7d5db747ff7/Source/JavaScriptCore/COPYING.LIB

This notice preserves the component identity and exact source locations. It
does not itself provide the object/source and relinking materials required for
distribution of a statically linked executable. See `docs/release.md` before
publishing a release that contains the cookie helper.
