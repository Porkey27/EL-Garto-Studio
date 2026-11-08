// egcap: 10-bit (HDR) capture helper for Windows.
//
// Chromium and ffmpeg's DirectShow input cannot open a capture card in P010 (10-bit 4:2:0), but
// Media Foundation can. egcap opens the card in P010 and hands the frames to ffmpeg, which encodes
// them (HEVC Main 10 on the GPU). The card can only be opened by one program at a time, so egcap
// also sends a small SDR preview (JPEG frames, tone mapped when the input is HDR) for the app to
// show while it records.
//
//   egcap list
//       JSON on stdout: video capture devices and the P010 formats each offers.
//   egcap capture --video <match> [--audio <match>] --vpipe <name> [--apipe <name>]
//                 [--eotf 0|2|3] [--preview WxH]
//       <match> is a case-insensitive substring of the device's name or symbolic link (for
//       example "vid_0fd9&pid_00af"). Status goes to stderr as JSON lines:
//         {"event":"format","width":..,"height":..,"fpsNum":..,"fpsDen":..,"audio":{..}|null}
//         {"event":"started"}  {"event":"stats",..}  {"event":"error","message":".."}  {"event":"stopped",..}
//       After "format" it creates \\.\pipe\<vpipe> (raw p010le frames, constant frame rate) and
//       \\.\pipe\<apipe> (raw PCM), and starts streaming once both are opened. Video frames are
//       repeated or dropped and audio padded or trimmed by their timestamps, so the two stay in
//       sync when the reader counts frames and samples. Preview frames go to stdout as
//       [u32 little-endian length][JPEG]. Writing "q" to stdin, or closing it, stops the capture;
//       the pipes are then closed so ffmpeg can finish the file.
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <wincodec.h>
#include <io.h>
#include <fcntl.h>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdarg>
#include <cstdio>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mf.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "windowscodecs.lib")

using Buf = std::vector<uint8_t>;
using BufPtr = std::shared_ptr<Buf>;

static std::mutex g_errMu;
static std::atomic<bool> g_stop{false};

static void emit(const char* fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  std::lock_guard<std::mutex> l(g_errMu);
  fputs(buf, stderr);
  fputc('\n', stderr);
  fflush(stderr);
}

static void fail(const char* what, HRESULT hr = S_OK) {
  if (hr != S_OK) emit("{\"event\":\"error\",\"message\":\"%s (0x%08lx)\"}", what, (unsigned long)hr);
  else emit("{\"event\":\"error\",\"message\":\"%s\"}", what);
}

static std::string utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

static std::string jsonStr(const std::wstring& w) {
  std::string out = "\"";
  for (char c : utf8(w)) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if ((unsigned char)c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); out += b; }
    else out += c;
  }
  return out + "\"";
}

static std::wstring lower(std::wstring s) {
  for (auto& c : s) c = towlower(c);
  return s;
}

template <class T> static void release(T*& p) { if (p) { p->Release(); p = nullptr; } }

// ---- devices ----------------------------------------------------------------------------------

struct DeviceInfo { std::wstring name, link; IMFActivate* act = nullptr; };

static std::vector<DeviceInfo> enumDevices(bool video) {
  std::vector<DeviceInfo> out;
  IMFAttributes* attr = nullptr;
  MFCreateAttributes(&attr, 1);
  attr->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, video ? MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID : MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_GUID);
  IMFActivate** devs = nullptr;
  UINT32 n = 0;
  if (SUCCEEDED(MFEnumDeviceSources(attr, &devs, &n))) {
    for (UINT32 i = 0; i < n; i++) {
      DeviceInfo d;
      WCHAR* s = nullptr;
      UINT32 len = 0;
      if (SUCCEEDED(devs[i]->GetAllocatedString(MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &s, &len))) { d.name = s; CoTaskMemFree(s); }
      const GUID& key = video ? MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK : MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_ENDPOINT_ID;
      if (SUCCEEDED(devs[i]->GetAllocatedString(key, &s, &len))) { d.link = s; CoTaskMemFree(s); }
      d.act = devs[i];
      out.push_back(d);
    }
    CoTaskMemFree(devs);
  }
  attr->Release();
  return out;
}

static void freeDevices(std::vector<DeviceInfo>& v) { for (auto& d : v) release(d.act); }

static IMFMediaSource* openSource(bool video, const std::wstring& match, std::wstring* nameOut) {
  auto devs = enumDevices(video);
  std::wstring m = lower(match);
  IMFMediaSource* src = nullptr;
  for (auto& d : devs) {
    if (lower(d.name).find(m) == std::wstring::npos && lower(d.link).find(m) == std::wstring::npos) continue;
    if (SUCCEEDED(d.act->ActivateObject(IID_PPV_ARGS(&src)))) { if (nameOut) *nameOut = d.name; break; }
  }
  freeDevices(devs);
  return src;
}

static IMFSourceReader* makeReader(IMFMediaSource* src) {
  IMFAttributes* attr = nullptr;
  MFCreateAttributes(&attr, 2);
  attr->SetUINT32(MF_LOW_LATENCY, TRUE);
  IMFSourceReader* rd = nullptr;
  HRESULT hr = MFCreateSourceReaderFromMediaSource(src, attr, &rd);
  attr->Release();
  if (FAILED(hr)) fail("could not create a source reader", hr);
  return rd;
}

struct VideoFormat { UINT32 w = 0, h = 0, num = 0, den = 1; };

static bool isP010(IMFMediaType* t) {
  GUID sub{};
  return SUCCEEDED(t->GetGUID(MF_MT_SUBTYPE, &sub)) && sub == MFVideoFormat_P010;
}

// The largest, then fastest, P010 type the device offers.
static IMFMediaType* bestP010(IMFSourceReader* rd, VideoFormat* f) {
  IMFMediaType* pick = nullptr;
  VideoFormat best;
  for (DWORD i = 0;; i++) {
    IMFMediaType* t = nullptr;
    if (FAILED(rd->GetNativeMediaType((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, i, &t))) break;
    VideoFormat c;
    MFGetAttributeSize(t, MF_MT_FRAME_SIZE, &c.w, &c.h);
    MFGetAttributeRatio(t, MF_MT_FRAME_RATE, &c.num, &c.den);
    double area = (double)c.w * c.h, bestArea = (double)best.w * best.h;
    double fps = c.den ? (double)c.num / c.den : 0, bestFps = best.den ? (double)best.num / best.den : 0;
    if (isP010(t) && (!pick || area > bestArea || (area == bestArea && fps > bestFps))) {
      release(pick);
      pick = t;
      best = c;
    } else {
      t->Release();
    }
  }
  if (f) *f = best;
  return pick;
}

static int cmdList() {
  auto devs = enumDevices(true);
  std::string out = "{\"devices\":[";
  for (size_t i = 0; i < devs.size(); i++) {
    auto& d = devs[i];
    out += (i ? "," : "");
    out += "{\"name\":" + jsonStr(d.name) + ",\"link\":" + jsonStr(d.link) + ",\"p010\":[";
    IMFMediaSource* src = nullptr;
    IMFSourceReader* rd = nullptr;
    // Reading the type list works while another program is streaming from the device.
    if (SUCCEEDED(d.act->ActivateObject(IID_PPV_ARGS(&src))) && (rd = makeReader(src))) {
      bool first = true;
      for (DWORD k = 0;; k++) {
        IMFMediaType* t = nullptr;
        if (FAILED(rd->GetNativeMediaType((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, k, &t))) break;
        if (isP010(t)) {
          VideoFormat c;
          MFGetAttributeSize(t, MF_MT_FRAME_SIZE, &c.w, &c.h);
          MFGetAttributeRatio(t, MF_MT_FRAME_RATE, &c.num, &c.den);
          char b[128];
          snprintf(b, sizeof b, "%s{\"width\":%u,\"height\":%u,\"fpsNum\":%u,\"fpsDen\":%u}", first ? "" : ",", c.w, c.h, c.num, c.den);
          out += b;
          first = false;
        }
        t->Release();
      }
    }
    release(rd);
    if (src) { src->Shutdown(); src->Release(); }
    d.act->ShutdownObject();
    out += "]}";
  }
  out += "]}\n";
  freeDevices(devs);
  fwrite(out.data(), 1, out.size(), stdout);
  return 0;
}

// ---- frame buffers ----------------------------------------------------------------------------

// Fixed set of frame buffers, reused once nothing else holds them (the writer queue, the preview
// slot). When all are in use the reader drops the frame and the writer repeats the previous one.
class Pool {
 public:
  Pool(size_t bytes, size_t max) : bytes_(bytes), max_(max) {}
  BufPtr get() {
    for (auto& b : all_) if (b.use_count() == 1) return b;
    if (all_.size() >= max_) return nullptr;
    all_.push_back(std::make_shared<Buf>(bytes_));
    return all_.back();
  }
 private:
  size_t bytes_, max_;
  std::vector<BufPtr> all_;
};

template <class T> class Queue {
 public:
  void push(T v) { { std::lock_guard<std::mutex> l(mu_); q_.push_back(std::move(v)); } cv_.notify_one(); }
  // False once closed and empty.
  bool pop(T& v) {
    std::unique_lock<std::mutex> l(mu_);
    cv_.wait(l, [&] { return !q_.empty() || closed_; });
    if (q_.empty()) return false;
    v = std::move(q_.front());
    q_.pop_front();
    return true;
  }
  void close() { { std::lock_guard<std::mutex> l(mu_); closed_ = true; } cv_.notify_all(); }
  size_t size() { std::lock_guard<std::mutex> l(mu_); return q_.size(); }
 private:
  std::mutex mu_;
  std::condition_variable cv_;
  std::deque<T> q_;
  bool closed_ = false;
};

struct VItem { BufPtr buf; LONGLONG t; };
struct AItem { Buf data; LONGLONG t; };

// ---- timing -----------------------------------------------------------------------------------

// Capture sources stamp samples either with the system clock or from zero at stream start.
// Bring both streams onto the system clock so they can be compared.
struct Clock {
  bool set = false;
  LONGLONG offset = 0;
  LONGLONG map(LONGLONG ts) {
    if (!set) {
      LONGLONG d = MFGetSystemTime() - ts;
      offset = (d > 50000000LL || d < -50000000LL) ? d : 0;
      set = true;
    }
    return ts + offset;
  }
};

static std::mutex g_t0Mu;
static std::condition_variable g_t0Cv;
static LONGLONG g_t0 = 0;
static bool g_t0Set = false;

static bool waitT0(LONGLONG* t0) {
  std::unique_lock<std::mutex> l(g_t0Mu);
  g_t0Cv.wait(l, [] { return g_t0Set || g_stop.load(); });
  *t0 = g_t0;
  return g_t0Set;
}

// ---- pipes ------------------------------------------------------------------------------------

static HANDLE makePipe(const std::wstring& name) {
  std::wstring path = L"\\\\.\\pipe\\" + name;
  HANDLE h = CreateNamedPipeW(path.c_str(), PIPE_ACCESS_OUTBOUND, PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 8 << 20, 0, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) fail("could not create a pipe", HRESULT_FROM_WIN32(GetLastError()));
  return h;
}

// Blocks until the reader opens the pipe. To give up, connect to it ourselves (unblock()).
static bool waitClient(HANDLE h) {
  if (ConnectNamedPipe(h, nullptr)) return true;
  return GetLastError() == ERROR_PIPE_CONNECTED;
}

static void unblock(const std::wstring& name) {
  std::wstring path = L"\\\\.\\pipe\\" + name;
  HANDLE c = CreateFileW(path.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  if (c != INVALID_HANDLE_VALUE) CloseHandle(c);
}

static bool writeAll(HANDLE h, const uint8_t* p, size_t n) {
  while (n) {
    DWORD chunk = (DWORD)(n > (1u << 24) ? (1u << 24) : n), done = 0;
    if (!WriteFile(h, p, chunk, &done, nullptr)) return false;
    p += done;
    n -= done;
  }
  return true;
}

// ---- preview ----------------------------------------------------------------------------------

// P010 (BT.709 SDR, or BT.2020 PQ/HLG) to 8-bit BGR, scaled down by point sampling, with a simple
// tone map for HDR. Only for the preview: the recording keeps the original 10-bit frames.
class Previewer {
 public:
  Previewer(UINT32 w, UINT32 h, UINT32 pw, UINT32 ph, int eotf) : w_(w), h_(h), pw_(pw), ph_(ph), eotf_(eotf), bgr_((size_t)pw * ph * 3) {
    for (int i = 0; i < 1024; i++) lin_[i] = toLinear(i / 1023.0f);
    for (int i = 0; i < 4096; i++) gamma_[i] = (uint8_t)lroundf(255.0f * powf(i / 4095.0f, 1 / 2.2f));
    xs_.resize(pw);
    for (UINT32 x = 0; x < pw; x++) xs_[x] = (UINT32)(((uint64_t)x * w + w / 2) / pw) & ~1u;
    CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&wic_));
  }
  ~Previewer() { release(wic_); }

  bool encode(const uint8_t* frame, Buf& jpeg) {
    convert(frame);
    return wic_ && toJpeg(jpeg);
  }

 private:
  // Normalised so 1.0 is SDR reference white (203 nits).
  float toLinear(float e) const {
    if (eotf_ == 2) {  // PQ (SMPTE ST 2084)
      const float m1 = 0.1593017578125f, m2 = 78.84375f, c1 = 0.8359375f, c2 = 18.8515625f, c3 = 18.6875f;
      float p = powf(e, 1 / m2);
      float l = powf(fmaxf(p - c1, 0.0f) / (c2 - c3 * p), 1 / m1);
      return l * 10000.0f / 203.0f;
    }
    if (eotf_ == 3) {  // HLG, display referred at 1000 nits (OOTF left out)
      const float a = 0.17883277f, b = 0.28466892f, c = 0.55991073f;
      float l = e <= 0.5f ? e * e / 3.0f : (expf((e - c) / a) + b) / 12.0f;
      return l * 1000.0f / 203.0f;
    }
    return e;
  }

  static float toneMap(float x) {  // extended Reinhard, white at 1000 nits
    const float w = 1000.0f / 203.0f;
    x = fmaxf(x, 0.0f);
    return fminf(x * (1 + x / (w * w)) / (1 + x), 1.0f);
  }

  void convert(const uint8_t* frame) {
    const uint16_t* Y = (const uint16_t*)frame;
    const uint16_t* UV = Y + (size_t)w_ * h_;
    const bool hdr = eotf_ == 2 || eotf_ == 3;
    // Y'CbCr to R'G'B' (limited range): BT.2020 for HDR, BT.709 otherwise.
    const float kr = hdr ? 0.2627f : 0.2126f, kb = hdr ? 0.0593f : 0.0722f, kg = 1 - kr - kb;
    const float rv = 2 * (1 - kr), bu = 2 * (1 - kb), gu = -bu * kb / kg, gv = -rv * kr / kg;
    for (UINT32 y = 0; y < ph_; y++) {
      UINT32 sy = (UINT32)(((uint64_t)y * h_ + h_ / 2) / ph_) & ~1u;
      const uint16_t* yrow = Y + (size_t)sy * w_;
      const uint16_t* uvrow = UV + (size_t)(sy / 2) * w_;
      uint8_t* out = &bgr_[(size_t)y * pw_ * 3];
      for (UINT32 x = 0; x < pw_; x++) {
        UINT32 sx = xs_[x];
        float l = ((yrow[sx] >> 6) - 64) / 876.0f;
        float u = ((uvrow[sx] >> 6) - 512) / 896.0f;
        float v = ((uvrow[sx + 1] >> 6) - 512) / 896.0f;
        float r = l + rv * v, g = l + gu * u + gv * v, b = l + bu * u;
        if (hdr) {
          r = lin_[idx(r)]; g = lin_[idx(g)]; b = lin_[idx(b)];
          // BT.2020 to BT.709 primaries.
          float r7 = 1.6605f * r - 0.5876f * g - 0.0728f * b;
          float g7 = -0.1246f * r + 1.1329f * g - 0.0083f * b;
          float b7 = -0.0182f * r - 0.1006f * g + 1.1187f * b;
          out[0] = gamma_[(int)(toneMap(b7) * 4095)];
          out[1] = gamma_[(int)(toneMap(g7) * 4095)];
          out[2] = gamma_[(int)(toneMap(r7) * 4095)];
        } else {
          out[0] = (uint8_t)lroundf(fminf(fmaxf(b, 0), 1) * 255);
          out[1] = (uint8_t)lroundf(fminf(fmaxf(g, 0), 1) * 255);
          out[2] = (uint8_t)lroundf(fminf(fmaxf(r, 0), 1) * 255);
        }
        out += 3;
      }
    }
  }

  static int idx(float e) { return e <= 0 ? 0 : e >= 1 ? 1023 : (int)(e * 1023); }

  bool toJpeg(Buf& jpeg) {
    IStream* st = nullptr;
    IWICBitmapEncoder* enc = nullptr;
    IWICBitmapFrameEncode* fr = nullptr;
    IPropertyBag2* props = nullptr;
    bool ok = false;
    if (SUCCEEDED(CreateStreamOnHGlobal(nullptr, TRUE, &st)) &&
        SUCCEEDED(wic_->CreateEncoder(GUID_ContainerFormatJpeg, nullptr, &enc)) &&
        SUCCEEDED(enc->Initialize(st, WICBitmapEncoderNoCache)) &&
        SUCCEEDED(enc->CreateNewFrame(&fr, &props))) {
      PROPBAG2 opt = {};
      opt.pstrName = (LPOLESTR)L"ImageQuality";
      VARIANT v;
      VariantInit(&v);
      v.vt = VT_R4;
      v.fltVal = 0.75f;
      props->Write(1, &opt, &v);
      WICPixelFormatGUID pf = GUID_WICPixelFormat24bppBGR;
      if (SUCCEEDED(fr->Initialize(props)) && SUCCEEDED(fr->SetSize(pw_, ph_)) && SUCCEEDED(fr->SetPixelFormat(&pf)) &&
          SUCCEEDED(fr->WritePixels(ph_, pw_ * 3, (UINT)bgr_.size(), bgr_.data())) && SUCCEEDED(fr->Commit()) && SUCCEEDED(enc->Commit())) {
        STATSTG s = {};
        st->Stat(&s, STATFLAG_NONAME);
        LARGE_INTEGER zero = {};
        st->Seek(zero, STREAM_SEEK_SET, nullptr);
        jpeg.resize((size_t)s.cbSize.QuadPart);
        ULONG got = 0;
        ok = SUCCEEDED(st->Read(jpeg.data(), (ULONG)jpeg.size(), &got)) && got == jpeg.size();
      }
    }
    release(props);
    release(fr);
    release(enc);
    release(st);
    return ok;
  }

  UINT32 w_, h_, pw_, ph_;
  int eotf_;
  Buf bgr_;
  std::vector<UINT32> xs_;
  float lin_[1024];
  uint8_t gamma_[4096];
  IWICImagingFactory* wic_ = nullptr;
};

// ---- capture ----------------------------------------------------------------------------------

struct Options {
  std::wstring video, audio, vpipe, apipe;
  int eotf = 0;
  UINT32 pw = 960, ph = 540;
};

struct AudioFormat { UINT32 rate = 0, channels = 0, bits = 0; bool isFloat = false; };

// Copies a frame into a packed buffer (Y plane, then the interleaved CbCr plane).
static bool copyFrame(IMFSample* smp, UINT32 w, UINT32 h, Buf& out) {
  IMFMediaBuffer* mb = nullptr;
  if (FAILED(smp->GetBufferByIndex(0, &mb))) return false;
  const size_t row = (size_t)w * 2, rows = (size_t)h * 3 / 2;
  bool ok = false;
  IMF2DBuffer* b2 = nullptr;
  BYTE* p = nullptr;
  LONG pitch = 0;
  if (SUCCEEDED(mb->QueryInterface(IID_PPV_ARGS(&b2))) && SUCCEEDED(b2->Lock2D(&p, &pitch))) {
    if (pitch > 0) {
      for (size_t r = 0; r < rows; r++) memcpy(&out[r * row], p + r * pitch, row);
      ok = true;
    }
    b2->Unlock2D();
  } else {
    DWORD len = 0;
    if (SUCCEEDED(mb->Lock(&p, nullptr, &len))) {
      size_t pt = rows ? len / rows : 0;
      if (pt >= row) {
        for (size_t r = 0; r < rows; r++) memcpy(&out[r * row], p + r * pt, row);
        ok = true;
      }
      mb->Unlock();
    }
  }
  release(b2);
  mb->Release();
  return ok;
}

static int cmdCapture(const Options& o) {
  std::wstring vname, aname;
  IMFMediaSource* vsrc = openSource(true, o.video, &vname);
  if (!vsrc) { fail("capture device not found"); return 1; }
  IMFSourceReader* vrd = makeReader(vsrc);
  if (!vrd) return 1;
  VideoFormat vf;
  IMFMediaType* vt = bestP010(vrd, &vf);
  if (!vt) { fail("the device offers no 10-bit (P010) format"); return 1; }
  HRESULT hr = vrd->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, nullptr, vt);
  vt->Release();
  if (FAILED(hr)) { fail("could not select the 10-bit format", hr); return 1; }

  IMFMediaSource* asrc = nullptr;
  IMFSourceReader* ard = nullptr;
  AudioFormat af;
  if (!o.audio.empty() && !o.apipe.empty()) {
    asrc = openSource(false, o.audio, &aname);
    if (asrc && (ard = makeReader(asrc))) {
      IMFMediaType* native = nullptr;
      ard->GetNativeMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, &native);
      UINT32 rate = native ? MFGetAttributeUINT32(native, MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000) : 48000;
      UINT32 ch = native ? MFGetAttributeUINT32(native, MF_MT_AUDIO_NUM_CHANNELS, 2) : 2;
      release(native);
      for (int isFloat = 0; isFloat < 2 && !af.rate; isFloat++) {
        IMFMediaType* t = nullptr;
        MFCreateMediaType(&t);
        UINT32 bits = isFloat ? 32 : 16;
        t->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
        t->SetGUID(MF_MT_SUBTYPE, isFloat ? MFAudioFormat_Float : MFAudioFormat_PCM);
        t->SetUINT32(MF_MT_AUDIO_SAMPLES_PER_SECOND, rate);
        t->SetUINT32(MF_MT_AUDIO_NUM_CHANNELS, ch);
        t->SetUINT32(MF_MT_AUDIO_BITS_PER_SAMPLE, bits);
        t->SetUINT32(MF_MT_AUDIO_BLOCK_ALIGNMENT, ch * bits / 8);
        t->SetUINT32(MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * ch * bits / 8);
        if (SUCCEEDED(ard->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, t))) af = {rate, ch, bits, isFloat != 0};
        t->Release();
      }
      if (!af.rate) { release(ard); emit("{\"event\":\"warning\",\"message\":\"audio format not accepted; recording without audio\"}"); }
    } else {
      emit("{\"event\":\"warning\",\"message\":\"audio device not found; recording without audio\"}");
    }
  }
  const bool withAudio = ard != nullptr;

  // Preview size: fit within the requested box, even dimensions.
  UINT32 pw = o.pw, ph = (UINT32)((uint64_t)pw * vf.h / vf.w);
  if (ph > o.ph) { ph = o.ph; pw = (UINT32)((uint64_t)ph * vf.w / vf.h); }
  pw &= ~1u; ph &= ~1u;

  char abuf[160] = "null";
  if (withAudio) snprintf(abuf, sizeof abuf, "{\"rate\":%u,\"channels\":%u,\"format\":\"%s\",\"name\":%s}", af.rate, af.channels, af.isFloat ? "f32le" : "s16le", jsonStr(aname).c_str());
  emit("{\"event\":\"format\",\"width\":%u,\"height\":%u,\"fpsNum\":%u,\"fpsDen\":%u,\"device\":%s,\"audio\":%s,\"preview\":{\"width\":%u,\"height\":%u}}",
       vf.w, vf.h, vf.num, vf.den, jsonStr(vname).c_str(), abuf, pw, ph);

  HANDLE vpipe = makePipe(o.vpipe);
  HANDLE apipe = withAudio ? makePipe(o.apipe) : INVALID_HANDLE_VALUE;
  if (vpipe == INVALID_HANDLE_VALUE || (withAudio && apipe == INVALID_HANDLE_VALUE)) return 1;

  // stdin: "q" or end of input stops the capture.
  std::thread ctl([&] {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    char c;
    DWORD n = 0;
    while (ReadFile(in, &c, 1, &n, nullptr) && n == 1) if (c == 'q') break;
    g_stop = true;
    g_t0Cv.notify_all();
    unblock(o.vpipe);
    if (withAudio) unblock(o.apipe);
  });
  ctl.detach();

  // ffmpeg reads from its first input (video) before it opens the second, so start streaming as
  // soon as the video pipe is open; the audio writer connects on its own and catches up.
  bool connected = waitClient(vpipe);
  if (!connected || g_stop) { fail(g_stop ? "stopped before the encoder connected" : "the encoder did not connect"); return 1; }

  const size_t frameBytes = (size_t)vf.w * vf.h * 3;  // P010: 2 bytes per sample, 4:2:0
  Pool pool(frameBytes, frameBytes ? max((size_t)6, (size_t)(384ull << 20) / frameBytes) : 6);
  Queue<VItem> vq;
  Queue<AItem> aq;
  std::atomic<uint64_t> captured{0}, written{0}, repeated{0}, dropped{0}, audioPadded{0}, audioTrimmed{0};
  std::atomic<bool> writeFailed{false};
  const double fps = vf.den ? (double)vf.num / vf.den : 60.0;

  // Preview: the newest frame only, at up to 30 per second.
  std::mutex pmu;
  std::condition_variable pcv;
  BufPtr pending;
  bool previewDone = false;
  std::thread previewer([&] {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    {
      Previewer pv(vf.w, vf.h, pw, ph, o.eotf);
      Buf jpeg;
      for (;;) {
        BufPtr f;
        {
          std::unique_lock<std::mutex> l(pmu);
          pcv.wait(l, [&] { return pending || previewDone; });
          if (previewDone) break;
          f = std::move(pending);
        }
        if (pv.encode(f->data(), jpeg)) {
          uint32_t len = (uint32_t)jpeg.size();
          fwrite(&len, 4, 1, stdout);
          fwrite(jpeg.data(), 1, jpeg.size(), stdout);
          fflush(stdout);
        }
      }
    }
    CoUninitialize();
  });

  std::thread vwriter([&] {
    LONGLONG t0;
    if (!waitT0(&t0)) return;
    BufPtr last;
    uint64_t n = 0;
    VItem it;
    while (vq.pop(it)) {
      if (writeFailed) continue;
      long long idx = llround((double)(it.t - t0) * fps / 1e7);
      if (idx < (long long)n) { dropped++; continue; }
      // Repeat the previous frame over a gap (dropped frames, or no signal for a moment).
      while ((long long)n < idx && last) {
        if (!writeAll(vpipe, last->data(), last->size())) { writeFailed = true; break; }
        n++;
        repeated++;
      }
      if (writeFailed || !writeAll(vpipe, it.buf->data(), it.buf->size())) { writeFailed = true; continue; }
      n++;
      last = std::move(it.buf);
      written = n;
    }
    FlushFileBuffers(vpipe);
    CloseHandle(vpipe);
  });

  std::thread awriter([&] {
    if (!withAudio) return;
    LONGLONG t0;
    bool ok = waitClient(apipe) && !g_stop.load() ? true : false;
    if (!ok || !waitT0(&t0)) { AItem drop; while (aq.pop(drop)) {} CloseHandle(apipe); return; }
    const size_t frame = (size_t)af.channels * af.bits / 8;
    const long long slack = af.rate / 50;  // 20 ms of jitter is left alone
    long long n = 0;
    Buf silence;
    AItem it;
    while (aq.pop(it)) {
      if (writeFailed) continue;
      long long frames = (long long)(it.data.size() / frame);
      long long pos = llround((double)(it.t - t0) * af.rate / 1e7);
      long long skip = 0;
      if (pos > n + slack) {
        silence.assign((size_t)(pos - n) * frame, 0);
        if (!writeAll(apipe, silence.data(), silence.size())) { writeFailed = true; continue; }
        audioPadded += pos - n;
        n = pos;
      } else if (pos < n - slack) {
        skip = min(frames, n - pos);
        audioTrimmed += skip;
      }
      if (skip >= frames) continue;
      if (!writeAll(apipe, it.data.data() + skip * frame, (size_t)(frames - skip) * frame)) { writeFailed = true; continue; }
      n += frames - skip;
    }
    FlushFileBuffers(apipe);
    CloseHandle(apipe);
  });

  std::thread areader([&] {
    if (!withAudio) return;
    Clock clk;
    while (!g_stop) {
      DWORD flags = 0;
      LONGLONG ts = 0;
      IMFSample* smp = nullptr;
      HRESULT r = ard->ReadSample((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, nullptr, &flags, &ts, &smp);
      if (FAILED(r) || (flags & MF_SOURCE_READERF_ENDOFSTREAM)) { if (!g_stop) emit("{\"event\":\"warning\",\"message\":\"audio stopped (0x%08lx)\"}", (unsigned long)r); break; }
      if (!smp) continue;
      IMFMediaBuffer* mb = nullptr;
      if (SUCCEEDED(smp->ConvertToContiguousBuffer(&mb))) {
        BYTE* p = nullptr;
        DWORD len = 0;
        if (SUCCEEDED(mb->Lock(&p, nullptr, &len))) {
          aq.push({Buf(p, p + len), clk.map(ts)});
          mb->Unlock();
        }
        mb->Release();
      }
      smp->Release();
    }
  });

  emit("{\"event\":\"started\"}");
  Clock vclk;
  LONGLONG lastPreview = 0;
  ULONGLONG lastStats = GetTickCount64();
  const char* stopReason = nullptr;
  while (!g_stop && !writeFailed) {
    DWORD flags = 0;
    LONGLONG ts = 0;
    IMFSample* smp = nullptr;
    hr = vrd->ReadSample((DWORD)MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0, nullptr, &flags, &ts, &smp);
    if (FAILED(hr)) { stopReason = "the capture device stopped sending video"; break; }
    if (flags & MF_SOURCE_READERF_ENDOFSTREAM) { stopReason = "the capture device ended the stream"; break; }
    if (flags & (MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED | MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED)) { release(smp); stopReason = "the input format changed"; break; }
    if (!smp) continue;
    LONGLONG t = vclk.map(ts);
    if (!g_t0Set) {
      std::lock_guard<std::mutex> l(g_t0Mu);
      g_t0 = t;
      g_t0Set = true;
      g_t0Cv.notify_all();
    }
    captured++;
    BufPtr b = pool.get();
    if (b && copyFrame(smp, vf.w, vf.h, *b)) {
      if (t - lastPreview >= 333333 - 20000) {  // ~30 per second
        lastPreview = t;
        std::lock_guard<std::mutex> l(pmu);
        pending = b;
        pcv.notify_one();
      }
      vq.push({std::move(b), t});
    } else {
      dropped++;
    }
    smp->Release();
    if (GetTickCount64() - lastStats >= 1000) {
      lastStats = GetTickCount64();
      emit("{\"event\":\"stats\",\"captured\":%llu,\"written\":%llu,\"repeated\":%llu,\"dropped\":%llu,\"queue\":%zu,\"audioPadded\":%llu,\"audioTrimmed\":%llu}",
           captured.load(), written.load(), repeated.load(), dropped.load(), vq.size(), audioPadded.load(), audioTrimmed.load());
    }
  }
  if (writeFailed) stopReason = "the encoder stopped reading";
  if (stopReason) fail(stopReason);
  g_stop = true;
  g_t0Cv.notify_all();

  areader.join();
  vq.close();
  aq.close();
  if (withAudio) unblock(o.apipe);  // in case the encoder never opened the audio pipe
  vwriter.join();
  awriter.join();
  { std::lock_guard<std::mutex> l(pmu); previewDone = true; }
  pcv.notify_all();
  previewer.join();

  release(vrd);
  release(ard);
  if (vsrc) { vsrc->Shutdown(); vsrc->Release(); }
  if (asrc) { asrc->Shutdown(); asrc->Release(); }
  emit("{\"event\":\"stopped\",\"captured\":%llu,\"written\":%llu,\"repeated\":%llu,\"dropped\":%llu,\"audioPadded\":%llu,\"audioTrimmed\":%llu}",
       captured.load(), written.load(), repeated.load(), dropped.load(), audioPadded.load(), audioTrimmed.load());
  return stopReason && !writeFailed && written == 0 ? 1 : 0;
}

int wmain(int argc, wchar_t** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  if (argc < 2) { fwprintf(stderr, L"usage: egcap list | egcap capture --video <match> --vpipe <name> [--audio <match> --apipe <name>] [--eotf n] [--preview WxH]\n"); return 2; }
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  MFStartup(MF_VERSION);
  int rc = 2;
  if (wcscmp(argv[1], L"list") == 0) {
    rc = cmdList();
  } else if (wcscmp(argv[1], L"capture") == 0) {
    Options o;
    for (int i = 2; i + 1 < argc; i += 2) {
      std::wstring k = argv[i], v = argv[i + 1];
      if (k == L"--video") o.video = v;
      else if (k == L"--audio") o.audio = v;
      else if (k == L"--vpipe") o.vpipe = v;
      else if (k == L"--apipe") o.apipe = v;
      else if (k == L"--eotf") o.eotf = _wtoi(v.c_str());
      else if (k == L"--preview") swscanf_s(v.c_str(), L"%ux%u", &o.pw, &o.ph);
    }
    if (o.video.empty() || o.vpipe.empty()) { fail("--video and --vpipe are required"); rc = 2; }
    else rc = cmdCapture(o);
  }
  MFShutdown();
  CoUninitialize();
  return rc;
}
