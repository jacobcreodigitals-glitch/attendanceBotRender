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

app.get("/", (req, res) => {
  res.send("Attendance Bot is running!")
})

app.get("/test-sheets", async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A1:F10",
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
      range: "Sheet1!A:F",
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
      return res.send("You have already clocked in today.")
    }

    // Add new attendance record
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A:F",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[date, userName, userId, time, "", ""]],
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
      range: "Sheet1!A:F",
    })

    const rows = response.data.values || []

    // Find today's attendance row for this user
    let rowNumber = null
    let existingClockOut = false
    let clockIn = null

    for (let i = 0; i < rows.length; i++) {
      const rowDate = rows[i][0]
      const rowUserId = rows[i][2]
      const rowClockIn = rows[i][3]
      const rowClockOut = rows[i][4]

      if (rowDate === date && rowUserId === userId) {
        rowNumber = i + 1
        clockIn = rowClockIn
        existingClockOut = rowClockOut
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

    // Convert clock-in and clock-out times into Date objects
    const clockInDate = new Date(`${date} ${clockIn}`)
    const clockOutDate = new Date(`${date} ${time}`)

    // Calculate hours worked
    const millisecondsWorked = clockOutDate - clockInDate
    const hoursWorked = millisecondsWorked / (1000 * 60 * 60)

    // Round to 2 decimal places
    const hours = hoursWorked.toFixed(2)

    // Update Clock Out and Hours columns
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Sheet1!E${rowNumber}:F${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[time, hours]],
      },
    })

    res.send(`Clocked out successfully at ${time}. Hours worked: ${hours}`)
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
      range: "Sheet1!A:F",
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

    // Build attendance table
    let message = `📋 Attendance for ${date}\n\n`

    message += "```"
    message += "Name          | In       | Out      | Hours\n"
    message += "--------------|----------|----------|------\n"

    todayRows.forEach((row) => {
      const userName = row[1] || "-"
      const clockIn = row[3] || "-"
      const clockOut = row[4] || "-"
      const hours = row[5] || "-"

      // Shorten times from 11:17:09 AM → 11:17 AM
      const formattedClockIn = formatAttendanceTime(clockIn)
      const formattedClockOut = formatAttendanceTime(clockOut)

      // Keep the name column aligned
      const formattedName = userName.padEnd(13, " ").slice(0, 13)

      const formattedIn = formattedClockIn.padEnd(9, " ").slice(0, 9)
      const formattedOut = formattedClockOut.padEnd(9, " ").slice(0, 9)

      message += `${formattedName}| ${formattedIn}| ${formattedOut}| ${hours}\n`
    })

    message += "```"

    res.send(message)
  } catch (error) {
    console.error(error)

    res.status(500).send("There was an error getting attendance.")
  }
})

app.post("/slack/invoice", async (req, res) => {
  try {
    const { date } = getPhilippineDateTime()

    // Get today's date
    const today = new Date()

    // Get date 14 days before today
    // This gives us 15 calendar days including today
    const startDate = new Date(today)
    startDate.setDate(today.getDate() - 14)

    // Read attendance records
    const attendanceResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Sheet1!A:F",
    })

    const attendanceRows = attendanceResponse.data.values || []

    // Read employee rates
    const ratesResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Rates!A:C",
    })

    const ratesRows = ratesResponse.data.values || []

    // Create a rate lookup using Slack ID
    const rates = {}

    for (let i = 1; i < ratesRows.length; i++) {
      const userName = ratesRows[i][0]
      const slackId = ratesRows[i][1]
      const hourlyRate = parseFloat(ratesRows[i][2])

      if (slackId && !isNaN(hourlyRate)) {
        rates[slackId] = {
          userName,
          hourlyRate,
        }
      }
    }

    // Store invoice totals by Slack ID
    const invoiceData = {}

    // Process attendance records
    for (let i = 1; i < attendanceRows.length; i++) {
      const row = attendanceRows[i]

      const rowDate = row[0]
      const userName = row[1]
      const slackId = row[2]
      const hours = parseFloat(row[5])

      // Skip incomplete records
      if (!rowDate || !slackId || isNaN(hours)) {
        continue
      }

      // Convert sheet date into a Date object
      const attendanceDate = new Date(rowDate)

      // Skip invalid dates
      if (isNaN(attendanceDate.getTime())) {
        continue
      }

      // Check if attendance is inside the 15-day period
      if (attendanceDate < startDate || attendanceDate > today) {
        continue
      }

      // Create user entry if it doesn't exist
      if (!invoiceData[slackId]) {
        invoiceData[slackId] = {
          userName: userName,
          hours: 0,
        }
      }

      // Add hours
      invoiceData[slackId].hours += hours
    }

    // No completed hours
    if (Object.keys(invoiceData).length === 0) {
      return res.send(
        `No completed attendance records from ${startDate.toLocaleDateString(
          "en-US",
        )} to ${date}.`,
      )
    }

    // Build invoice message
    let message = `🧾 Invoice\n`
    message += `Period: ${startDate.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    })} - ${date}\n\n`

    message += "```"
    message += "Name          | Hours    | Rate     | Amount\n"
    message += "--------------|----------|----------|----------\n"

    let totalHours = 0
    let totalAmount = 0

    Object.keys(invoiceData).forEach((slackId) => {
      const employee = invoiceData[slackId]

      const hours = employee.hours
      const rateInfo = rates[slackId]

      // Use rate from Rates sheet
      const rate = rateInfo ? rateInfo.hourlyRate : 0

      const amount = hours * rate

      totalHours += hours
      totalAmount += amount

      const name = employee.userName.padEnd(13, " ").slice(0, 13)

      const formattedHours = hours.toFixed(2).padStart(8, " ")
      const formattedRate = rate.toFixed(2).padStart(8, " ")
      const formattedAmount = amount.toFixed(2).padStart(8, " ")

      message += `${name}|${formattedHours} |${formattedRate} |${formattedAmount}\n`
    })

    message += "--------------|----------|----------|----------\n"

    message += `Total         |${totalHours
      .toFixed(2)
      .padStart(8, " ")} |          |${totalAmount
      .toFixed(2)
      .padStart(8, " ")}\n`

    message += "```"

    res.send(message)
  } catch (error) {
    console.error(error)

    res.status(500).send("There was an error generating the invoice.")
  }
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
