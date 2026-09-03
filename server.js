require("dotenv").config()

const express = require("express")
const { google } = require("googleapis")

const app = express()

const PORT = process.env.PORT || 3000

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// ============================================================
// GOOGLE AUTHENTICATION
// ============================================================

let auth

if (process.env.GOOGLE_SERVICE_ACCOUNT) {
  auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  })
} else {
  auth = new google.auth.GoogleAuth({
    keyFile: "./credentials/service-account.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  })
}

const sheets = google.sheets({
  version: "v4",
  auth,
})

// ============================================================
// CONFIG
// ============================================================

const SPREADSHEET_ID = "1bw1K7vC5MPsE65YVu64B-vIKnR4t8PeVovjIN25sFiA"

const ATTENDANCE_RANGE = "Sheet1!A:F"
const RATES_RANGE = "Rates!A:C"
const PHILIPPINE_TIMEZONE = "Asia/Manila"

// Prevent two identical clock-in requests from being processed
// at the exact same time on this server instance.
const pendingClockIns = new Set()

// ============================================================
// DATE / TIME HELPERS
// ============================================================

function getPhilippineDateTime() {
  const now = new Date()

  const date = now.toLocaleDateString("en-US", {
    timeZone: PHILIPPINE_TIMEZONE,
  })

  const time = now.toLocaleTimeString("en-US", {
    timeZone: PHILIPPINE_TIMEZONE,
  })

  return {
    date,
    time,
  }
}

function formatAttendanceTime(time) {
  if (!time || time === "-") {
    return "-"
  }

  const parts = time.split(" ")

  if (parts.length !== 2) {
    return time
  }

  const timeParts = parts[0].split(":")

  if (timeParts.length < 2) {
    return time
  }

  const hours = timeParts[0]
  const minutes = timeParts[1]
  const period = parts[1]

  return `${hours}:${minutes} ${period}`
}

// ============================================================
// GOOGLE SHEETS HELPERS
// ============================================================

async function getAttendanceRows() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: ATTENDANCE_RANGE,
  })

  return response.data.values || []
}

async function getRatesRows() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: RATES_RANGE,
  })

  return response.data.values || []
}

// Find a user's attendance record for a specific date.
function findAttendanceRecord(rows, date, userId) {
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]

    const rowDate = row[0]
    const rowUserId = row[2]

    if (rowDate === date && rowUserId === userId) {
      return {
        row,
        rowNumber: i + 1,
      }
    }
  }

  return null
}

// ============================================================
// SLACK TABLE HELPERS
// ============================================================

// Creates a consistently aligned Slack code-block table.
function createSlackTable(headers, rows, widths) {
  const formatCell = (value, width) => {
    const text = String(value ?? "-")

    // Prevent long values from breaking the table.
    return text.slice(0, width).padEnd(width, " ")
  }

  const header = headers
    .map((header, index) => formatCell(header, widths[index]))
    .join(" | ")

  const separator = widths.map((width) => "-".repeat(width)).join("-+-")

  const body = rows
    .map((row) =>
      row.map((value, index) => formatCell(value, widths[index])).join(" | "),
    )
    .join("\n")

  return ["```", header, separator, body, "```"].join("\n")
}

// ============================================================
// BASIC ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.send("Attendance Bot is running!")
})

// ============================================================
// TEST GOOGLE SHEETS
// ============================================================

app.get("/test-sheets", async (req, res) => {
  try {
    const rows = await getAttendanceRows()

    console.log(rows)

    res.json(rows)
  } catch (error) {
    console.error(error)

    res.status(500).send("Google Sheets error")
  }
})

// ============================================================
// CLOCK IN
// ============================================================

app.post("/slack/clockin", async (req, res) => {
  const userName = req.body.user_name
  const userId = req.body.user_id
  const responseUrl = req.body.response_url

  if (!userName || !userId) {
    return res.status(400).send("Missing Slack user information.")
  }

  const { date, time } = getPhilippineDateTime()

  const lockKey = `${date}:${userId}`

  // Prevent simultaneous duplicate requests.
  if (pendingClockIns.has(lockKey)) {
    return res.send("Your clock-in is already being processed.")
  }

  pendingClockIns.add(lockKey)

  // Acknowledge Slack immediately.
  res.send("Clock-in request received. Processing...")

  try {
    const rows = await getAttendanceRows()

    // Check whether the user already clocked in today.
    const existingRecord = findAttendanceRecord(rows, date, userId)

    let message

    if (existingRecord) {
      message = "You have already clocked in today."
    } else {
      // Create exactly one attendance record.
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: ATTENDANCE_RANGE,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [[date, userName, userId, time, "", ""]],
        },
      })

      message = `Clocked in successfully at ${time}`
    }

    // Send the final result back to Slack.
    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          response_type: "ephemeral",
          text: message,
        }),
      })
    }
  } catch (error) {
    console.error("Clock-in error:", error)

    if (responseUrl) {
      try {
        await fetch(responseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            response_type: "ephemeral",
            text: "There was an error clocking in.",
          }),
        })
      } catch (slackError) {
        console.error("Slack response error:", slackError)
      }
    }
  } finally {
    pendingClockIns.delete(lockKey)
  }
})

// ============================================================
// CLOCK OUT
// ============================================================

app.post("/slack/clockout", async (req, res) => {
  const userId = req.body.user_id
  const responseUrl = req.body.response_url

  if (!userId) {
    return res.status(400).send("Missing Slack user ID.")
  }

  // Acknowledge Slack immediately.
  res.send("Clock-out request received. Processing...")

  try {
    const { date, time } = getPhilippineDateTime()

    const rows = await getAttendanceRows()

    const record = findAttendanceRecord(rows, date, userId)

    let message

    // User has not clocked in.
    if (!record) {
      message = "You cannot clock out because you have not clocked in today."
    } else {
      const clockIn = record.row[3]
      const existingClockOut = record.row[4]

      // User already clocked out.
      if (existingClockOut) {
        message = "You have already clocked out today."
      } else if (!clockIn) {
        message = "Your clock-in time could not be found."
      } else {
        // Convert times into Date objects.
        const clockInDate = new Date(`${date} ${clockIn}`)
        const clockOutDate = new Date(`${date} ${time}`)

        let millisecondsWorked = clockOutDate.getTime() - clockInDate.getTime()

        // Lunch break: 12:00 PM - 1:00 PM.
        const lunchStart = new Date(`${date} 12:00 PM`)
        const lunchEnd = new Date(`${date} 1:00 PM`)

        // Deduct 1 hour only when the work period overlaps the lunch break.
        const overlapsLunch =
          clockInDate < lunchEnd && clockOutDate > lunchStart

        if (overlapsLunch) {
          millisecondsWorked -= 60 * 60 * 1000
        }

        const hoursWorked = millisecondsWorked / (1000 * 60 * 60)

        const hours = Math.max(0, hoursWorked).toFixed(2)

        // Update Clock Out + Hours.
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Sheet1!E${record.rowNumber}:F${record.rowNumber}`,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[time, hours]],
          },
        })

        message = `Clocked out successfully at ${time}. Hours worked: ${hours}`
      }
    }

    // Send the final result back to Slack.
    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          response_type: "ephemeral",
          text: message,
        }),
      })
    }
  } catch (error) {
    console.error("Clock-out error:", error)

    if (responseUrl) {
      try {
        await fetch(responseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            response_type: "ephemeral",
            text: "There was an error clocking out.",
          }),
        })
      } catch (slackError) {
        console.error("Slack response error:", slackError)
      }
    }
  }
})

// ============================================================
// ATTENDANCE
// ============================================================

app.post("/slack/attendance", async (req, res) => {
  const responseUrl = req.body.response_url

  // Acknowledge Slack immediately.
  res.send("Attendance request received. Processing...")

  try {
    const { date } = getPhilippineDateTime()

    const rows = await getAttendanceRows()

    // Only today's records.
    const todayRows = rows.filter((row, index) => {
      if (index === 0) {
        return false
      }

      return row[0] === date
    })

    let message

    if (todayRows.length === 0) {
      message = `No attendance records for ${date}.`
    } else {
      const tableRows = todayRows.map((row) => {
        const userName = row[1] || "-"
        const clockIn = formatAttendanceTime(row[3])
        const clockOut = formatAttendanceTime(row[4])
        const hours = row[5] || "-"

        return [userName, clockIn, clockOut, hours]
      })

      const table = createSlackTable(
        ["Name", "In", "Out", "Hours"],
        tableRows,
        [16, 10, 10, 7],
      )

      message = `📋 Attendance for ${date}\n\n${table}`
    }

    // Send the final result back to Slack.
    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          response_type: "in_channel",
          text: message,
        }),
      })
    }
  } catch (error) {
    console.error("Attendance error:", error)

    if (responseUrl) {
      try {
        await fetch(responseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            response_type: "ephemeral",
            text: "There was an error getting attendance.",
          }),
        })
      } catch (slackError) {
        console.error("Slack response error:", slackError)
      }
    }
  }
})

// ============================================================
// INVOICE
// ============================================================

app.post("/slack/invoice", async (req, res) => {
  const responseUrl = req.body.response_url

  // Acknowledge Slack immediately.
  res.send("Invoice request received. Processing...")

  try {
    const { date } = getPhilippineDateTime()

    // ----------------------------------------------------------
    // Calculate 15-day invoice period.
    // ----------------------------------------------------------

    const now = new Date()

    const startDate = new Date(now)
    startDate.setDate(now.getDate() - 14)

    // ----------------------------------------------------------
    // Get attendance + rates.
    // ----------------------------------------------------------

    const [attendanceRows, ratesRows] = await Promise.all([
      getAttendanceRows(),
      getRatesRows(),
    ])

    // ----------------------------------------------------------
    // Build rate lookup.
    // ----------------------------------------------------------

    const rates = {}

    for (let i = 1; i < ratesRows.length; i++) {
      const row = ratesRows[i]

      const userName = row[0]
      const slackId = row[1]
      const hourlyRate = parseFloat(row[2])

      if (slackId && !isNaN(hourlyRate)) {
        rates[slackId] = {
          userName,
          hourlyRate,
        }
      }
    }

    // ----------------------------------------------------------
    // Aggregate attendance by Slack ID.
    // ----------------------------------------------------------

    const invoiceData = {}

    for (let i = 1; i < attendanceRows.length; i++) {
      const row = attendanceRows[i]

      const rowDate = row[0]
      const userName = row[1]
      const slackId = row[2]
      const hours = parseFloat(row[5])

      // Only completed attendance records.
      if (!rowDate || !slackId || isNaN(hours)) {
        continue
      }

      const attendanceDate = new Date(rowDate)

      if (isNaN(attendanceDate.getTime())) {
        continue
      }

      // Only records inside invoice period.
      if (attendanceDate < startDate || attendanceDate > now) {
        continue
      }

      // Create user once.
      if (!invoiceData[slackId]) {
        invoiceData[slackId] = {
          userName,
          hours: 0,
        }
      }

      // Add hours to the existing user.
      invoiceData[slackId].hours += hours
    }

    // ----------------------------------------------------------
    // No completed records.
    // ----------------------------------------------------------

    const employees = Object.values(invoiceData)

    let message

    if (employees.length === 0) {
      message = `No completed attendance records from ${startDate.toLocaleDateString(
        "en-US",
      )} to ${date}.`
    } else {
      // ----------------------------------------------------------
      // Build invoice table.
      // ----------------------------------------------------------

      let totalHours = 0
      let totalAmount = 0

      const tableRows = []

      for (const [slackId, employee] of Object.entries(invoiceData)) {
        const hours = employee.hours

        const rateInfo = rates[slackId]

        const rate = rateInfo ? rateInfo.hourlyRate : 0

        const amount = hours * rate

        totalHours += hours
        totalAmount += amount

        tableRows.push([
          employee.userName,
          hours.toFixed(2),
          rate.toFixed(2),
          amount.toFixed(2),
        ])
      }

      // Add total row.
      tableRows.push([
        "Total",
        totalHours.toFixed(2),
        "",
        totalAmount.toFixed(2),
      ])

      const table = createSlackTable(
        ["Name", "Hours", "Rate", "Amount"],
        tableRows,
        [16, 8, 10, 10],
      )

      // ----------------------------------------------------------
      // Final Slack message.
      // ----------------------------------------------------------

      const periodStart = startDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })

      const periodEnd = new Date(now).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })

      message =
        `🧾 Invoice\n` + `Period: ${periodStart} - ${periodEnd}\n\n` + table
    }

    // Send the final result back to Slack.
    if (responseUrl) {
      await fetch(responseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          response_type: "ephemeral",
          text: message,
        }),
      })
    }
  } catch (error) {
    console.error("Invoice error:", error)

    if (responseUrl) {
      try {
        await fetch(responseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            response_type: "ephemeral",
            text: "There was an error generating the invoice.",
          }),
        })
      } catch (slackError) {
        console.error("Slack response error:", slackError)
      }
    }
  }
})

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
