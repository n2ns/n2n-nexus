// Package autoupdate embeds the scheduler scripts also shipped with the npm client.
package autoupdate

import _ "embed"

//go:embed schedule.sh
var Unix string

//go:embed schedule.ps1
var Windows string
