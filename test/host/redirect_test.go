package plugin

import (
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

type redirectFixture func(*http.Request) (*http.Response, error)

func (f redirectFixture) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// A CDN 302 previously failed in the real host fetch implementation and invoked yt-dlp.
func TestYouTubeRedirect(t *testing.T) {
	dir := os.Getenv("MYGO_YOUTUBE_PLUGIN")
	if dir == "" {
		t.Skip("plugin bundle path required")
	}
	before := http.DefaultTransport
	defer func() { http.DefaultTransport = before }()
	original, destination := 0, 0
	http.DefaultTransport = redirectFixture(func(r *http.Request) (*http.Response, error) {
		status, body := 200, ""
		headers := make(http.Header)
		switch {
		case r.URL.Path == "/youtubei/v1/visitor_id":
			body = `{"responseContext":{"visitorData":"test"}}`
		case r.URL.Path == "/youtubei/v1/player":
			body = `{"playabilityStatus":{"status":"OK"},"streamingData":{"adaptiveFormats":[{"url":"https://first.googlevideo.com/audio","mimeType":"audio/mp4","bitrate":128000}]}}`
		case r.URL.Hostname() == "first.googlevideo.com":
			original++
			status = 302
			headers.Set("Location", "https://second.googlevideo.com/audio")
		case r.URL.Hostname() == "second.googlevideo.com":
			destination++
			if r.Header.Get("Range") != "bytes=0-511" {
				t.Error("lost range request")
			}
			status, body = 206, "\x00\x00\x00\x18ftypM4A "
		default:
			t.Errorf("unexpected request host %s", r.URL.Hostname())
			status = 500
		}
		return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	p, err := Load(dir, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	// No process grant: any mistaken fallback fails rather than running a helper.
	for i := 0; i < 2; i++ {
		stream, err := p.Stream("aaaaaaaaaa1", "")
		if err != nil {
			t.Fatal(err)
		}
		if stream.URL != "https://second.googlevideo.com/audio" {
			t.Fatal("unverified destination returned")
		}
	}
	if original != 1 || destination != 2 {
		t.Fatalf("redirect/cache requests: %d/%d", original, destination)
	}
}
