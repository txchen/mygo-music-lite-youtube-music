package player

import (
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
		video = "5NV6Rdv1a3I"
	}
	stream, err := src.Stream(video, "")
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	asked := 0
	resolved := streamer{asked: &asked, st: *stream}
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
