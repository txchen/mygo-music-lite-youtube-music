package player

import (
	"encoding/json"
	"github.com/egoist/mygo"
	"math"
	"mygo-music/internal/music"
	"mygo-music/internal/plugin"
	"os"
	"testing"
	"time"
)

// The real plugin resolves a YouTube stream which the native player can pause and seek.
func TestYouTubePluginLive(t *testing.T) {
	dir := os.Getenv("MYGO_YOUTUBE_PLUGIN")
	if dir == "" {
		t.Skip("set MYGO_YOUTUBE_PLUGIN for live service verification")
	}
	src, err := plugin.Load(dir, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if err := src.Grant(true); err != nil {
		t.Fatal(err)
	}
	if a, err := src.Account(); err != nil || a != nil {
		t.Fatalf("guest account: %v", err)
	}
	found, err := src.Search("Big Buck Bunny", music.SearchTracks, 0)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(found.Tracks) == 0 {
		t.Fatal("search returned no tracks")
	}
	t.Logf("live search returned %d tracks", len(found.Tracks))
	video := os.Getenv("MYGO_YOUTUBE_VIDEO")
	if video == "" {
		video = "aqz-KE-bpKQ"
	}
	resolveStarted := time.Now()
	stream, err := src.Stream(video, "")
	t.Logf("stream resolution %s", time.Since(resolveStarted))
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	asked := 0
	resolved := streamer{asked: &asked, st: *stream}
	playStarted := time.Now()
	var p *Player
	mygo.RunOnMain(func() {
		p = New(func(f func()) { mygo.RunOnMain(f) })
		p.Quiet = p.post
		p.Source = func(string) music.Source { return resolved }
		p.SetVolume(0)
		p.PlayQueue([]music.Track{{ID: video, Source: "youtube-music-lite"}}, 0)
	})
	defer mygo.RunOnMain(p.Close)
	wait := func(check func() bool) {
		t.Helper()
		end := time.Now().Add(25 * time.Second)
		for time.Now().Before(end) {
			var ok bool
			var failure string
			mygo.RunOnMain(func() { ok = check(); failure = p.Err() })
			if failure != "" {
				t.Fatalf("native playback: %s", failure)
			}
			if ok {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("native playback timed out")
	}
	wait(func() bool { return p.Ready() && p.Position() > 200*time.Millisecond })
	t.Logf("native start through 200ms playback %s", time.Since(playStarted))
	mygo.RunOnMain(func() { t.Logf("native engine %T", p.out); p.TogglePlay(); p.Seek(10 * time.Second) })
	wait(func() bool { return math.Abs(p.Position().Seconds()-10) < 0.5 })
	mygo.RunOnMain(func() {
		if p.Playing() {
			t.Error("seek resumed paused playback")
		}
		p.TogglePlay()
	})
	wait(func() bool { return p.Position() > 10500*time.Millisecond })
}

// Public YouTube CDN bytes remain seekable through the native relay.
func TestYouTubeDirectLive(t *testing.T) {
	path := os.Getenv("MYGO_YOUTUBE_DIRECT")
	if path == "" {
		t.Skip("set MYGO_YOUTUBE_DIRECT")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		URL     string            `json:"url"`
		Headers map[string]string `json:"http_headers"`
	}
	if err = json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	relay, err := newAudioRelay(&music.Stream{URL: result.URL, Headers: result.Headers, Type: "m4a"})
	if err != nil {
		t.Fatal(err)
	}
	defer relay.Close()
	defer func() {
		if t.Failed() {
			t.Logf("relay failure %v", relay.Err())
		}
	}()
	var out engine
	mygo.RunOnMain(func() { out, err = openAVPlayer(&music.Stream{URL: relay.url, Type: "m4a"}) })
	if err != nil {
		t.Fatal(err)
	}
	defer mygo.RunOnMain(out.Close)
	youtubeWait(t, func() bool {
		state, e := out.Poll()
		if e != nil {
			err = e
			return true
		}
		return state == outputReady
	})
	if err != nil {
		t.Fatal(err)
	}
	mygo.RunOnMain(func() { out.SetVolume(0); out.Play() })
	youtubeWait(t, func() bool { return out.Position() > 200*time.Millisecond })
	mygo.RunOnMain(func() { out.Pause(); out.Seek(10 * time.Second) })
	youtubeWait(t, func() bool { return math.Abs(out.Position().Seconds()-10) < 0.5 })
	mygo.RunOnMain(func() { out.Play() })
	youtubeWait(t, func() bool { return out.Position() > 10500*time.Millisecond })
	if err := relay.Err(); err != nil {
		t.Fatal(err)
	}
}

func youtubeWait(t *testing.T, check func() bool) {
	t.Helper()
	end := time.Now().Add(25 * time.Second)
	for time.Now().Before(end) {
		ok := false
		mygo.RunOnMain(func() { ok = check() })
		if ok {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("native network timeout")
}
