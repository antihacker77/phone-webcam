# Third-party component: Unity Capture

`UnityCaptureFilter32.dll` and `UnityCaptureFilter64.dll` are the DirectShow
virtual-camera filter from [Unity Capture](https://github.com/schellingb/UnityCapture)
by Bernhard Schelling, redistributed unmodified.

The filter is licensed under the MIT License:

    Copyright (c) 2018 Bernhard Schelling
    Copyright (c) 2016 MHD Yamen Saraiji

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.

Why it's bundled alongside the OBS Virtual Camera filter: the OBS filter
deliberately outputs nothing when loaded inside `obs64.exe` (feedback-loop
guard), so OBS Studio itself can't use it as a source. Unity Capture has no
such guard — it's registered under the name "Phone Webcam" and is the device
to pick inside OBS.
