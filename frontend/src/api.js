import { getAuth } from 'firebase/auth'

const BASE_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:8000"

const getToken = async () => {
  const auth = getAuth()
  const user = auth.currentUser
  if (user) {
    return await user.getIdToken()
  }
  return null
}

export const predictRisk = async (formData) => {
  const token = await getToken()

  const payload = {
    age: parseInt(formData.age),
    sex: parseInt(formData.sex),
    height_cm: parseFloat(formData.height_cm),
    weight_kg: parseFloat(formData.weight_kg),
    waist_cm: parseFloat(formData.waist_cm),
    physical_activity_level: parseInt(formData.physical_activity_level),
    sleep_hours: parseFloat(formData.sleep_hours),
    stress_level: parseInt(formData.stress_level),
    smoking_status: parseInt(formData.smoking_status),
    sugar_intake_level: parseInt(formData.sugar_intake_level),
    fried_food_consumption: parseInt(formData.fried_food_consumption),
    water_intake_liters: parseFloat(formData.water_intake_liters),
    salt_intake_level: parseInt(formData.salt_intake_level),
    chest_discomfort: parseInt(formData.chest_discomfort),
    excessive_thirst_fatigue: parseInt(formData.excessive_thirst_fatigue),
    family_history_heart: parseInt(formData.family_history_heart),
    family_history_diabetes: parseInt(formData.family_history_diabetes)
  }

  console.log("Sending to API:", payload)
  console.log("Field count:",
    Object.keys(payload).length)

  const headers = {
    "Content-Type": "application/json"
  }
  if (token) {
    headers["Authorization"] =
      `Bearer ${token}`
  }

  const response = await fetch(
    `${BASE_URL}/predict`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const error = await response.text()
    console.error("API Error:", error)
    throw new Error(
      `Prediction failed: ${error}`)
  }

  const data = await response.json()
  console.log("API Response:", data)
  return data
}

export const getDietPlan = async (
  heartRisk, diabetesRisk,
  obesityRisk, medications) => {
  const token = await getToken()
  const headers = {
    "Content-Type": "application/json"
  }
  if (token) {
    headers["Authorization"] =
      `Bearer ${token}`
  }

  const response = await fetch(
    `${BASE_URL}/diet`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      heart_risk: heartRisk,
      diabetes_risk: diabetesRisk,
      obesity_risk: obesityRisk,
      medications: medications
    })
  })

  if (!response.ok) {
    throw new Error("Diet plan failed")
  }
  return response.json()
}

export const sendAlert = async (
  userName, heartRisk,
  diabetesRisk, obesityRisk) => {
  const token = await getToken()
  if (!token) {
    throw new Error("Authentication required to send health alerts")
  }

  const response = await fetch(
    `${BASE_URL}/send-alert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify({
      userName,
      heartRisk,
      diabetesRisk,
      obesityRisk
    })
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}))
    throw new Error(errorData.detail || `Alert failed with status ${response.status}`)
  }

  return response.json()
}

export const sendFamilyAlerts = async (
  userName,
  familyEmails,
  heartRisk,
  diabetesRisk,
  obesityRisk
) => {
  try {
    return await sendAlert(userName, heartRisk, diabetesRisk, obesityRisk)
  } catch (e) {
    console.error('Alert send error:', e)
    return { sent: false, sent_count: 0, recipient_count: 0, message: e.message }
  }
}
