package plugin

import (
	"mygo-music/internal/music"
	"os"
	"testing"
)

// The shipped bundle maps current YouTube catalog responses through the real host runtime.
func TestYouTubeCatalogLive(t *testing.T) {
	dir := os.Getenv("MYGO_YOUTUBE_PLUGIN")
	if dir == "" {
		t.Skip("live plugin path required")
	}
	p, err := Load(dir, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	t.Run("home", func(t *testing.T) {
		b, e := p.Home()
		if e != nil {
			t.Fatal(e)
		}
		if len(b.Sections) == 0 {
			t.Fatal("empty home")
		}
		t.Logf("sections %d", len(b.Sections))
	})
	for _, kind := range []music.SearchKind{music.SearchTracks, music.SearchAlbums, music.SearchArtists, music.SearchPlaylists} {
		t.Run(string(kind), func(t *testing.T) {
			r, e := p.Search("Daft Punk", kind, 0)
			if e != nil {
				t.Fatal(e)
			}
			switch kind {
			case music.SearchTracks:
				if len(r.Tracks) == 0 {
					t.Fatal("empty tracks")
				}
				t.Logf("tracks %d more %v", len(r.Tracks), r.More)
				if r.More {
					next, e := p.Search("Daft Punk", kind, len(r.Tracks))
					if e != nil {
						t.Fatal(e)
					}
					if len(next.Tracks) == 0 {
						t.Fatal("empty continuation")
					}
					t.Logf("next %d", len(next.Tracks))
				}
			case music.SearchAlbums:
				if len(r.Albums) == 0 {
					t.Fatal("empty albums")
				}
				a, e := p.Album(r.Albums[0].ID)
				if e != nil {
					t.Fatal(e)
				}
				if len(a.Tracks) == 0 {
					t.Fatal("album has no tracks")
				}
				t.Logf("album tracks %d", len(a.Tracks))
			case music.SearchArtists:
				if len(r.Artists) == 0 {
					t.Fatal("empty artists")
				}
				a, e := p.Artist(r.Artists[0].ID)
				if e != nil {
					t.Fatal(e)
				}
				if len(a.Tracks)+len(a.Albums) == 0 {
					t.Fatal("empty artist")
				}
				t.Logf("artist tracks %d albums %d", len(a.Tracks), len(a.Albums))
			case music.SearchPlaylists:
				if len(r.Playlists) == 0 {
					t.Fatal("empty playlists")
				}
				a, e := p.Playlist(r.Playlists[0].ID)
				if e != nil {
					t.Fatal(e)
				}
				if len(a.Tracks) == 0 {
					t.Fatal("playlist has no tracks")
				}
				t.Logf("playlist tracks %d", len(a.Tracks))
			}
		})
	}
}
