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
	for _, page := range []string{"charts", "new"} {
		t.Run(page, func(t *testing.T) {
			b, e := p.Browse(page)
			if e != nil {
				t.Fatal(e)
			}
			if len(b.Sections) == 0 {
				t.Fatal("empty page")
			}
			t.Logf("sections %d", len(b.Sections))
		})
	}
	t.Run("suggest", func(t *testing.T) {
		xs, e := p.Suggest("Daft")
		if e != nil {
			t.Fatal(e)
		}
		if len(xs) == 0 {
			t.Fatal("empty suggestions")
		}
		t.Logf("suggestions %d", len(xs))
	})
	t.Run("radio", func(t *testing.T) {
		stations, e := p.Stations()
		if e != nil {
			t.Fatal(e)
		}
		if len(stations) == 0 {
			t.Fatal("no stations")
		}
		if e := p.call("played", map[string]string{"id": "5NV6Rdv1a3I"}, nil); e != nil {
			t.Fatal(e)
		}
		tracks, e := p.StationNext(stations[0].ID)
		if e != nil {
			t.Fatal(e)
		}
		if len(tracks) == 0 {
			t.Fatal("empty station")
		}
		t.Logf("radio tracks %d", len(tracks))
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
