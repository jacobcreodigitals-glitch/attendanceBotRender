require("dotenv").config()

const express = require("express")
const { google } = require("googleapis")

const app = express()

const PORT = process.env.PORT || 3000

app.use(express.urlencoded({ extended: true }))
app.use(express.json())

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

const SPREADSHEET_ID = "1bw1K7vC5MPsE65YVu64B-vIKnR4t8PeVovjIN25sFiA"

const PHILIPPINE_TIMEZONE = "Asia/Manila"

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

app.get("/", (req, res) => {
  res.send("Attendance Bot is running!")
})

app.get("/test-sheets", async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A1:E10",
    })

    console.log(response.data.values)

    res.json(response.data.values)
  } catch (error) {
    console.error(error)

    res.status(500).send("Google Sheets error")
  }
})

app.post("/slack/clockin", async (req, res) => {
  try {
    const userName = req.body.user_name
    const userId = req.body.user_id

    const { date, time } = getPhilippineDateTime()

    // Get existing attendance records
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A:E",
    })

    const rows = response.data.values || []

    // Check if this user already clocked in today
    const alreadyClockedIn = rows.some((row) => {
      const rowDate = row[0]
      const rowUserId = row[2]

      return rowDate === date && rowUserId === userId
    })

    // Stop if already clocked in
    if (alreadyClockedIn) {
      return res.send(`You have already clocked in today.`)
    }

    // Add new attendance record
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[date, userName, userId, time, ""]],
      },
    })

    res.send(`Clocked in successfully at ${time}`)
  } catch (error) {
    console.error(error)

    res.status(500).send("There was an error clocking in.")
  }
})

app.post("/slack/clockout", async (req, res) => {
  try {
    const userId = req.body.user_id

    const { date, time } = getPhilippineDateTime()

    // Get attendance records
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A:E",
    })

    const rows = response.data.values || []

    // Find today's attendance row for this user
    let rowNumber = null
    let existingClockOut = false

    for (let i = 0; i < rows.length; i++) {
      const rowDate = rows[i][0]
      const rowUserId = rows[i][2]
      const clockOut = rows[i][4]

      if (rowDate === date && rowUserId === userId) {
        rowNumber = i + 1
        existingClockOut = clockOut
        break
      }
    }

    // User has not clocked in
    if (rowNumber === null) {
      return res.send(
        "You cannot clock out because you have not clocked in today.",
      )
    }

    // User already clocked out
    if (existingClockOut) {
      return res.send("You have already clocked out today.")
    }

    // Update Clock Out column
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sheet1!E${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[time]],
      },
    })

    res.send(`Clocked out successfully at ${time}`)
  } catch (error) {
    console.error(error)

    res.status(500).send("There was an error clocking out.")
  }
})

app.post("/slack/attendance", async (req, res) => {
  try {
    const { date } = getPhilippineDateTime()

    // Get attendance records
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A:E",
    })

    const rows = response.data.values || []

    // Get only today's attendance
    const todayRows = rows.filter((row) => {
      return row[0] === date
    })

    // No attendance yet
    if (todayRows.length === 0) {
      return res.send(`No attendance records for ${date}.`)
    }

    // Build attendance message
    let message = `Attendance for ${date}\n\n`

    todayRows.forEach((row) => {
      const userName = row[1]
      const clockIn = row[3] || "-"
      const clockOut = row[4] || "-"

      message += `${userName}\n`
      message += `Clock In: ${clockIn}\n`
      message += `Clock Out: ${clockOut}\n\n`
    })

    res.send(message)
  } catch (error) {
    console.error(error)

    res.status(500).send("There was an error getting attendance.")
  }
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
