package protocol

import "unicode/utf16"

// Text lengths in the contract (notifyTextChars and the like) count UTF-16
// code units, as JavaScript does.

// UnitLen is the length of s in UTF-16 code units.
func UnitLen(s string) int {
	units := 0
	for _, r := range s {
		n := utf16.RuneLen(r)
		if n < 0 {
			n = 1
		}
		units += n
	}
	return units
}

// CutUnits cuts s to at most limit UTF-16 code units, never splitting a surrogate pair.
func CutUnits(s string, limit int) string {
	units := 0
	for i, r := range s {
		n := utf16.RuneLen(r)
		if n < 0 {
			n = 1
		}
		if units+n > limit {
			return s[:i]
		}
		units += n
	}
	return s
}
