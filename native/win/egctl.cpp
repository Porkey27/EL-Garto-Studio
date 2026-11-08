// egctl.exe: Windows counterpart of native/egctl.c. Node spawns it per operation.
//
//   egctl list                                         -> JSON: HID interfaces + video capture devices (VID 0FD9 and others)
//   egctl hid caps        <path>                        -> JSON: input/output/feature report lengths
//   egctl hid write       <path> <hex>                  (output report; first byte = report id)
//   egctl hid input       <path> <reportid> <len>      -> hex [id, data...]
//   egctl hid feature-get <path> <reportid> <len>      -> hex [id, data...]
//   egctl hid feature-set <path> <hex>
//   egctl cam list        <devicepath>                  -> JSON: raw VideoProcAmp/CameraControl ranges and values
//   egctl cam set         <devicepath> <procamp|camera> <prop> <value> <flags>
//   egctl cam formats     <devicepath>                  -> JSON: [{fourcc,width,height,fps}]
//   egctl xu find         <devicepath> <guid>           -> node id or -1
//   egctl xu get|set|len|basic <devicepath> <guid> <node> <selector> [len|hex]
//
// <devicepath> is the DirectShow "DevicePath" (\\?\usb#vid_0fd9&pid_...#{...}\global).
// Errors go to stderr as "error: <op>: 0x<hresult|win32>", exit status 1.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <initguid.h>
#include <setupapi.h>
#include <cfgmgr32.h>
#include <devpkey.h>
#include <hidsdi.h>
#include <hidpi.h>
#include <dshow.h>
#include <dvdmedia.h>
#include <ks.h>
#include <ksmedia.h>
#include <ksproxy.h>
#include <vidcap.h>

#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

DEFINE_GUID(GUID_DEVINTERFACE_HID_LOCAL, 0x4D1E55B2, 0xF16F, 0x11CF, 0x88, 0xCB, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30);
DEFINE_GUID(KSNODETYPE_DEV_SPECIFIC_LOCAL, 0x941C7AC0, 0xC559, 0x11D0, 0x8A, 0x2B, 0x00, 0xA0, 0xC9, 0x25, 0x5A, 0xC1);

static int fail(const char *op, long code) {
  fprintf(stderr, "error: %s: 0x%08lx\n", op, (unsigned long)code);
  return 1;
}

static std::string utf8(const std::wstring &w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}

static std::wstring wide(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
  std::wstring w(n ? n - 1 : 0, L'\0');
  if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s, -1, &w[0], n);
  return w;
}

static std::string json(const std::string &s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; sprintf_s(b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}

static std::vector<BYTE> parseHex(const char *s) {
  std::vector<BYTE> out;
  while (*s) {
    while (*s == ' ' || *s == ':') s++;
    if (!s[0] || !s[1]) break;
    char b[3] = { s[0], s[1], 0 };
    out.push_back((BYTE)strtoul(b, nullptr, 16));
    s += 2;
  }
  return out;
}

static void printHex(const BYTE *b, size_t n) {
  for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
  printf("\n");
}

static bool parseGuid(const char *s, GUID *g) {
  std::wstring w = wide(s);
  if (w.empty() || w[0] != L'{') w = L"{" + w + L"}";
  return SUCCEEDED(CLSIDFromString(w.c_str(), g));
}

// Instance id of the USB device that owns an interface/child node (walks up past MI_xx nodes).
static std::wstring usbParent(DEVINST inst) {
  wchar_t id[MAX_DEVICE_ID_LEN];
  for (int depth = 0; depth < 6; depth++) {
    if (CM_Get_Device_IDW(inst, id, MAX_DEVICE_ID_LEN, 0) != CR_SUCCESS) return L"";
    std::wstring s(id);
    if (_wcsnicmp(id, L"USB\\VID_", 8) == 0 && s.find(L"&MI_") == std::wstring::npos) return s;
    DEVINST parent;
    if (CM_Get_Parent(&parent, inst, 0) != CR_SUCCESS) return L"";
    inst = parent;
  }
  return L"";
}

static std::wstring parentOfInterfacePath(const std::wstring &path) {
  ULONG size = 0;
  wchar_t inst[MAX_DEVICE_ID_LEN];
  ULONG len = sizeof(inst);
  DEVPROPTYPE type;
  if (CM_Get_Device_Interface_PropertyW(path.c_str(), &DEVPKEY_Device_InstanceId, &type, (PBYTE)inst, &len, 0) != CR_SUCCESS) return L"";
  (void)size;
  DEVINST dev;
  if (CM_Locate_DevNodeW(&dev, inst, CM_LOCATE_DEVNODE_NORMAL) != CR_SUCCESS) return L"";
  return usbParent(dev);
}

static HANDLE openHid(const char *path) {
  return CreateFileW(wide(path).c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
}

static bool hidCaps(HANDLE h, HIDP_CAPS *caps, HIDD_ATTRIBUTES *attr) {
  PHIDP_PREPARSED_DATA pp;
  if (attr) { attr->Size = sizeof(*attr); if (!HidD_GetAttributes(h, attr)) return false; }
  if (!HidD_GetPreparsedData(h, &pp)) return false;
  bool ok = HidP_GetCaps(pp, caps) == HIDP_STATUS_SUCCESS;
  HidD_FreePreparsedData(pp);
  return ok;
}

static int interfaceNumber(const std::wstring &path) {
  size_t p = 0;
  std::wstring lower = path;
  for (auto &c : lower) c = towlower(c);
  if ((p = lower.find(L"&mi_")) == std::wstring::npos) return -1;
  return (int)wcstol(lower.c_str() + p + 4, nullptr, 16);
}

static void listHid(std::string &out) {
  HDEVINFO set = SetupDiGetClassDevsW(&GUID_DEVINTERFACE_HID_LOCAL, nullptr, nullptr, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
  if (set == INVALID_HANDLE_VALUE) return;
  SP_DEVICE_INTERFACE_DATA ifd = { sizeof(ifd) };
  bool first = true;
  for (DWORD i = 0; SetupDiEnumDeviceInterfaces(set, nullptr, &GUID_DEVINTERFACE_HID_LOCAL, i, &ifd); i++) {
    DWORD need = 0;
    SetupDiGetDeviceInterfaceDetailW(set, &ifd, nullptr, 0, &need, nullptr);
    std::vector<BYTE> buf(need);
    auto *det = (SP_DEVICE_INTERFACE_DETAIL_DATA_W *)buf.data();
    det->cbSize = sizeof(*det);
    if (!SetupDiGetDeviceInterfaceDetailW(set, &ifd, det, need, nullptr, nullptr)) continue;
    std::wstring path = det->DevicePath;
    std::wstring lower = path;
    for (auto &c : lower) c = towlower(c);
    if (lower.find(L"vid_0fd9") == std::wstring::npos) continue;
    HANDLE h = CreateFileW(path.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr);
    HIDP_CAPS caps = {};
    HIDD_ATTRIBUTES attr = {};
    bool ok = h != INVALID_HANDLE_VALUE && hidCaps(h, &caps, &attr);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
    if (!ok) continue;
    char line[512];
    sprintf_s(line, "%s{\"path\":%s,\"vid\":%u,\"pid\":%u,\"interface\":%d,\"usagePage\":%u,\"input\":%u,\"output\":%u,\"feature\":%u,\"parent\":%s}",
              first ? "" : ",", json(utf8(path)).c_str(), attr.VendorID, attr.ProductID, interfaceNumber(path), caps.UsagePage,
              caps.InputReportByteLength, caps.OutputReportByteLength, caps.FeatureReportByteLength, json(utf8(parentOfInterfacePath(path))).c_str());
    out += line;
    first = false;
  }
  SetupDiDestroyDeviceInfoList(set);
}

static HRESULT findCaptureFilter(const std::wstring *wantPath, IBaseFilter **filter, std::string *listJson) {
  ICreateDevEnum *de = nullptr;
  IEnumMoniker *em = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_SystemDeviceEnum, nullptr, CLSCTX_INPROC_SERVER, IID_ICreateDevEnum, (void **)&de);
  if (FAILED(hr)) return hr;
  hr = de->CreateClassEnumerator(CLSID_VideoInputDeviceCategory, &em, 0);
  de->Release();
  if (hr != S_OK) return wantPath ? HRESULT_FROM_WIN32(ERROR_NOT_FOUND) : S_OK;
  IMoniker *m;
  bool first = true;
  hr = HRESULT_FROM_WIN32(ERROR_NOT_FOUND);
  while (em->Next(1, &m, nullptr) == S_OK) {
    IPropertyBag *bag = nullptr;
    if (SUCCEEDED(m->BindToStorage(nullptr, nullptr, IID_IPropertyBag, (void **)&bag))) {
      VARIANT name, path;
      VariantInit(&name);
      VariantInit(&path);
      bag->Read(L"FriendlyName", &name, nullptr);
      bag->Read(L"DevicePath", &path, nullptr);
      std::wstring p = path.vt == VT_BSTR ? path.bstrVal : L"";
      std::wstring n = name.vt == VT_BSTR ? name.bstrVal : L"";
      if (listJson && !p.empty()) {
        *listJson += (first ? "" : ",");
        *listJson += "{\"name\":" + json(utf8(n)) + ",\"path\":" + json(utf8(p)) + ",\"parent\":" + json(utf8(parentOfInterfacePath(p))) + "}";
        first = false;
      }
      if (wantPath && _wcsicmp(p.c_str(), wantPath->c_str()) == 0) {
        hr = m->BindToObject(nullptr, nullptr, IID_IBaseFilter, (void **)filter);
        VariantClear(&name);
        VariantClear(&path);
        bag->Release();
        m->Release();
        break;
      }
      VariantClear(&name);
      VariantClear(&path);
      bag->Release();
    }
    m->Release();
  }
  em->Release();
  return wantPath ? hr : S_OK;
}

static int cmdList() {
  std::string hid, video;
  listHid(hid);
  findCaptureFilter(nullptr, nullptr, &video);
  printf("{\"hid\":[%s],\"video\":[%s]}\n", hid.c_str(), video.c_str());
  return 0;
}

static int cmdHid(int argc, char **argv) {
  if (argc < 2) return 2;
  std::string op = argv[0];
  HANDLE h = openHid(argv[1]);
  if (h == INVALID_HANDLE_VALUE) return fail("open", GetLastError());
  HIDP_CAPS caps = {};
  if (!hidCaps(h, &caps, nullptr)) return fail("caps", GetLastError());
  if (op == "caps") {
    printf("{\"input\":%u,\"output\":%u,\"feature\":%u}\n", caps.InputReportByteLength, caps.OutputReportByteLength, caps.FeatureReportByteLength);
    return 0;
  }
  if (op == "write" || op == "feature-set") {
    if (argc < 3) return 2;
    std::vector<BYTE> data = parseHex(argv[2]);
    size_t size = op == "write" ? caps.OutputReportByteLength : caps.FeatureReportByteLength;
    if (data.size() > size) return fail("report too long", (long)data.size());
    data.resize(size, 0);
    BOOL ok = op == "write" ? HidD_SetOutputReport(h, data.data(), (ULONG)size) : HidD_SetFeature(h, data.data(), (ULONG)size);
    if (!ok) return fail(op.c_str(), GetLastError());
    return 0;
  }
  if (op == "xfer") {
    // Output report then input report in one process, as Studio does (the reply is read back
    // within a millisecond). Retries the read while the device is still busy.
    if (argc < 5) return 2;
    std::vector<BYTE> data = parseHex(argv[2]);
    data.resize(caps.OutputReportByteLength, 0);
    if (!HidD_SetOutputReport(h, data.data(), (ULONG)data.size())) return fail("write", GetLastError());
    // The requested length becomes the GET_REPORT wLength; Elgato cards stall requests longer than
    // their reply buffer (Studio asks for 2047 bytes on report 5), so it must not default to caps.
    size_t want = (size_t)strtoul(argv[4], nullptr, 0);
    std::vector<BYTE> buf(want ? want : caps.InputReportByteLength, 0);
    DWORD err = 0;
    for (int attempt = 0; attempt < 20; attempt++) {
      buf.assign(buf.size(), 0);
      buf[0] = (BYTE)strtoul(argv[3], nullptr, 0);
      if (HidD_GetInputReport(h, buf.data(), (ULONG)buf.size())) {
        printHex(buf.data(), buf.size());
        return 0;
      }
      err = GetLastError();
      Sleep(5);
    }
    return fail("input", err);
  }
  if (argc < 4) return 2;
  bool input = op == "input";
  size_t size = input ? caps.InputReportByteLength : caps.FeatureReportByteLength;
  size_t want = (size_t)strtoul(argv[3], nullptr, 0);
  std::vector<BYTE> buf(want ? want : size, 0);  // want = wLength on the wire (see xfer)
  buf[0] = (BYTE)strtoul(argv[2], nullptr, 0);
  BOOL ok = input ? HidD_GetInputReport(h, buf.data(), (ULONG)buf.size()) : HidD_GetFeature(h, buf.data(), (ULONG)buf.size());
  if (!ok) return fail(op.c_str(), GetLastError());
  printHex(buf.data(), buf.size());
  return 0;
}

static int cmdCam(int argc, char **argv) {
  if (argc < 2) return 2;
  std::string op = argv[0];
  std::wstring path = wide(argv[1]);
  IBaseFilter *f = nullptr;
  HRESULT hr = findCaptureFilter(&path, &f, nullptr);
  if (FAILED(hr) || !f) return fail("open camera", hr);
  if (op == "list") {
    IAMVideoProcAmp *pa = nullptr;
    IAMCameraControl *cc = nullptr;
    f->QueryInterface(IID_IAMVideoProcAmp, (void **)&pa);
    f->QueryInterface(IID_IAMCameraControl, (void **)&cc);
    std::string out = "[";
    bool first = true;
    auto add = [&](const char *set, long prop, long mn, long mx, long step, long def, long caps, long val, long flags) {
      char b[256];
      sprintf_s(b, "%s{\"set\":\"%s\",\"prop\":%ld,\"min\":%ld,\"max\":%ld,\"step\":%ld,\"default\":%ld,\"caps\":%ld,\"value\":%ld,\"flags\":%ld}",
                first ? "" : ",", set, prop, mn, mx, step, def, caps, val, flags);
      out += b;
      first = false;
    };
    long mn, mx, st, df, cf, v, fl;
    // 0-9 are the documented VideoProcAmp properties; 13 is the UVC power-line frequency.
    static const long procamp[] = { 0, 1, 2, 3, 4, 5, 7, 8, 9, 13 };
    if (pa) for (long p : procamp) if (SUCCEEDED(pa->GetRange(p, &mn, &mx, &st, &df, &cf)) && SUCCEEDED(pa->Get(p, &v, &fl))) add("procamp", p, mn, mx, st, df, cf, v, fl);
    if (cc) for (long p = 0; p <= 6; p++) if (SUCCEEDED(cc->GetRange(p, &mn, &mx, &st, &df, &cf)) && SUCCEEDED(cc->Get(p, &v, &fl))) add("camera", p, mn, mx, st, df, cf, v, fl);
    printf("%s]\n", out.c_str());
    if (pa) pa->Release();
    if (cc) cc->Release();
    f->Release();
    return 0;
  }
  if (op == "set") {
    if (argc < 6) return 2;
    std::string set = argv[2];
    long prop = strtol(argv[3], nullptr, 0), value = strtol(argv[4], nullptr, 0), flags = strtol(argv[5], nullptr, 0);
    if (set == "procamp") {
      IAMVideoProcAmp *pa = nullptr;
      hr = f->QueryInterface(IID_IAMVideoProcAmp, (void **)&pa);
      if (SUCCEEDED(hr)) { hr = pa->Set(prop, value, flags); pa->Release(); }
    } else {
      IAMCameraControl *cc = nullptr;
      hr = f->QueryInterface(IID_IAMCameraControl, (void **)&cc);
      if (SUCCEEDED(hr)) { hr = cc->Set(prop, value, flags); cc->Release(); }
    }
    f->Release();
    return FAILED(hr) ? fail("set", hr) : 0;
  }
  if (op == "formats") {
    ICaptureGraphBuilder2 *cgb = nullptr;
    IAMStreamConfig *sc = nullptr;
    hr = CoCreateInstance(CLSID_CaptureGraphBuilder2, nullptr, CLSCTX_INPROC_SERVER, IID_ICaptureGraphBuilder2, (void **)&cgb);
    if (SUCCEEDED(hr)) hr = cgb->FindInterface(&PIN_CATEGORY_CAPTURE, &MEDIATYPE_Video, f, IID_IAMStreamConfig, (void **)&sc);
    if (FAILED(hr) || !sc) { if (cgb) cgb->Release(); f->Release(); return fail("stream config", hr); }
    int count = 0, size = 0;
    sc->GetNumberOfCapabilities(&count, &size);
    std::vector<BYTE> capsBuf(size);
    std::string out = "[";
    bool first = true;
    for (int i = 0; i < count; i++) {
      AM_MEDIA_TYPE *mt = nullptr;
      if (FAILED(sc->GetStreamCaps(i, &mt, capsBuf.data())) || !mt) continue;
      long w = 0, hgt = 0;
      REFERENCE_TIME tpf = 0;
      if (mt->formattype == FORMAT_VideoInfo && mt->cbFormat >= sizeof(VIDEOINFOHEADER)) {
        auto *vi = (VIDEOINFOHEADER *)mt->pbFormat;
        w = vi->bmiHeader.biWidth; hgt = vi->bmiHeader.biHeight; tpf = vi->AvgTimePerFrame;
      } else if (mt->formattype == FORMAT_VideoInfo2 && mt->cbFormat >= sizeof(VIDEOINFOHEADER2)) {
        auto *vi = (VIDEOINFOHEADER2 *)mt->pbFormat;
        w = vi->bmiHeader.biWidth; hgt = vi->bmiHeader.biHeight; tpf = vi->AvgTimePerFrame;
      }
      char fourcc[5] = { (char)(mt->subtype.Data1 & 0xff), (char)((mt->subtype.Data1 >> 8) & 0xff), (char)((mt->subtype.Data1 >> 16) & 0xff), (char)((mt->subtype.Data1 >> 24) & 0xff), 0 };
      for (char &c : fourcc) if (c && (c < 0x20 || c > 0x7e)) c = '?';
      if (w > 0) {
        char b[160];
        sprintf_s(b, "%s{\"fourcc\":%s,\"width\":%ld,\"height\":%ld,\"fps\":%.3f}", first ? "" : ",", json(fourcc).c_str(), w, labs(hgt), tpf ? 1e7 / (double)tpf : 0.0);
        out += b;
        first = false;
      }
      if (mt->cbFormat) CoTaskMemFree(mt->pbFormat);
      if (mt->pUnk) mt->pUnk->Release();
      CoTaskMemFree(mt);
    }
    printf("%s]\n", out.c_str());
    sc->Release();
    cgb->Release();
    f->Release();
    return 0;
  }
  f->Release();
  return 2;
}

static HRESULT xuCall(IKsControl *ks, const GUID &set, ULONG node, ULONG sel, ULONG flags, void *data, ULONG len, ULONG *returned) {
  KSP_NODE p = {};
  p.Property.Set = set;
  p.Property.Id = sel;
  p.Property.Flags = flags | KSPROPERTY_TYPE_TOPOLOGY;
  p.NodeId = node;
  return ks->KsProperty((PKSPROPERTY)&p, sizeof(p), data, len, returned);
}

static int cmdXu(int argc, char **argv) {
  if (argc < 3) return 2;
  std::string op = argv[0];
  std::wstring path = wide(argv[1]);
  GUID set;
  if (!parseGuid(argv[2], &set)) return fail("bad guid", 0);
  IBaseFilter *f = nullptr;
  HRESULT hr = findCaptureFilter(&path, &f, nullptr);
  if (FAILED(hr) || !f) return fail("open camera", hr);
  IKsControl *ks = nullptr;
  IKsTopologyInfo *topo = nullptr;
  hr = f->QueryInterface(__uuidof(IKsControl), (void **)&ks);
  if (FAILED(hr)) { f->Release(); return fail("IKsControl", hr); }
  int rc = 0;
  if (op == "find") {
    // A node answers a zero-length GET for a control of its own property set with "more data".
    long found = -1;
    DWORD nodes = 0;
    if (SUCCEEDED(f->QueryInterface(__uuidof(IKsTopologyInfo), (void **)&topo)) && SUCCEEDED(topo->get_NumNodes(&nodes))) {
      for (DWORD n = 0; n < nodes && found < 0; n++) {
        GUID type;
        if (FAILED(topo->get_NodeType(n, &type)) || type != KSNODETYPE_DEV_SPECIFIC_LOCAL) continue;
        for (ULONG sel = 1; sel <= 4 && found < 0; sel++) {
          ULONG ret = 0;
          HRESULT h = xuCall(ks, set, n, sel, KSPROPERTY_TYPE_GET, nullptr, 0, &ret);
          if (h == HRESULT_FROM_WIN32(ERROR_MORE_DATA) || (SUCCEEDED(h) && ret > 0)) found = (long)n;
        }
      }
    }
    printf("%ld\n", found);
  } else {
    if (argc < 5) { rc = 2; goto done; }
    ULONG node = strtoul(argv[3], nullptr, 0), sel = strtoul(argv[4], nullptr, 0), ret = 0;
    if (op == "len") {
      hr = xuCall(ks, set, node, sel, KSPROPERTY_TYPE_GET, nullptr, 0, &ret);
      if (hr != HRESULT_FROM_WIN32(ERROR_MORE_DATA) && FAILED(hr)) rc = fail("len", hr);
      else printf("%lu\n", ret);
    } else if (op == "get") {
      ULONG len = argc > 5 ? strtoul(argv[5], nullptr, 0) : 0;
      std::vector<BYTE> buf(len ? len : 1);
      hr = xuCall(ks, set, node, sel, KSPROPERTY_TYPE_GET, buf.data(), len, &ret);
      if (FAILED(hr)) rc = fail("get", hr); else printHex(buf.data(), ret);
    } else if (op == "set") {
      std::vector<BYTE> data = argc > 5 ? parseHex(argv[5]) : std::vector<BYTE>();
      hr = xuCall(ks, set, node, sel, KSPROPERTY_TYPE_SET, data.data(), (ULONG)data.size(), &ret);
      if (FAILED(hr)) rc = fail("set", hr);
    } else if (op == "basic") {
      // KSPROPERTY_DESCRIPTION + member headers (ranges/default); parsed in JS.
      std::vector<BYTE> buf(512);
      hr = xuCall(ks, set, node, sel, KSPROPERTY_TYPE_BASICSUPPORT, buf.data(), (ULONG)buf.size(), &ret);
      if (FAILED(hr)) rc = fail("basic", hr); else printHex(buf.data(), ret);
    } else {
      rc = 2;
    }
  }
done:
  if (topo) topo->Release();
  ks->Release();
  f->Release();
  return rc;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: egctl list | hid ... | cam ... | xu ...\n");
    return 2;
  }
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  std::string cmd = argv[1];
  int rc = cmd == "list" ? cmdList()
         : cmd == "hid" ? cmdHid(argc - 2, argv + 2)
         : cmd == "cam" ? cmdCam(argc - 2, argv + 2)
         : cmd == "xu" ? cmdXu(argc - 2, argv + 2)
         : 2;
  if (rc == 2) fprintf(stderr, "usage error\n");
  CoUninitialize();
  return rc;
}
