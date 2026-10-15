from fastapi import FastAPI, HTTPException, Request, Depends
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.responses import JSONResponse
from schemas import PredictionRequest, PredictionResponse, AlertRequest, AlertResponse
from services.prediction import (
    get_heart_risk_prediction,
    get_diabetes_risk_prediction,
    get_obesity_risk_score,
    get_all_predictions)
from services.diet import generate_diet_plan
from services.alerts import send_family_alerts, should_send_alert
import firebase_admin
from firebase_admin import credentials, firestore, auth
import redis
import hashlib
import json
import os
import smtplib
import asyncio
import traceback
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv

load_dotenv()

# ── Rate Limiter ──
limiter = Limiter(key_func=get_remote_address)

def get_user_rate_limit_key(request: Request) -> str:
    token = request.headers.get("Authorization", "")
    if token.startswith("Bearer "):
        token = token[7:]
    if token:
        try:
            decoded = auth.verify_id_token(token)
            uid = decoded.get("uid")
            if uid:
                return f"user:{uid}"
        except Exception:
            pass
    return get_remote_address(request)

# ── FastAPI App ──
app = FastAPI(title="VitalScan API")

# ── CORS — must be first middleware ──
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5175",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000"

    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

# ── SlowAPI — after CORS ──
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)

@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request, exc):
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Try again in a minute."})

# ── Firebase Init ──
FIREBASE_AVAILABLE = False
db_firestore = None
try:
    cred_path = os.getenv("FIREBASE_CREDENTIALS", "serviceAccountKey.json")
    cred = credentials.Certificate(cred_path)
    firebase_admin.initialize_app(cred)
    db_firestore = firestore.client()
    FIREBASE_AVAILABLE = True
    print("[OK] Firebase connected")
except Exception as e:
    print(f"[!] Firebase disabled: {e}")

# ── Redis Init ──
REDIS_AVAILABLE = False
redis_client = None
try:
    redis_client = redis.Redis(
        host='localhost',
        port=6379,
        db=0,
        decode_responses=True,
        socket_connect_timeout=2)
    redis_client.ping()
    REDIS_AVAILABLE = True
    print("[OK] Redis connected")
except Exception as e:
    print(f"[!] Redis disabled: {e}")

# ── Token Verifier ──
def verify_token(request: Request):
    token = request.headers.get("Authorization", "")
    if token.startswith("Bearer "):
        token = token[7:]
    if not token:
        return None
    try:
        decoded = auth.verify_id_token(token)
        return decoded.get("uid")
    except Exception:
        return None

# ── Health Check ──
@app.get("/health")
async def health():
    return {
        "status": "VitalScan API running",
        "firebase": FIREBASE_AVAILABLE,
        "redis": REDIS_AVAILABLE
    }

# ── Predict Endpoint ──
@app.post("/predict", response_model=PredictionResponse)
@limiter.limit("20/minute")
async def predict(
    request: Request,
    body: PredictionRequest):
    try:
        request_dict = body.model_dump()
        
        data_values = [
            float(body.age),
            float(body.sex),
            float(body.height_cm),
            float(body.weight_kg),
            float(body.waist_cm),
            float(body.physical_activity_level),
            float(body.sleep_hours),
            float(body.stress_level),
            float(body.smoking_status),
            float(body.sugar_intake_level),
            float(body.fried_food_consumption),
            float(body.water_intake_liters),
            float(body.salt_intake_level),
            float(body.chest_discomfort),
            float(body.excessive_thirst_fatigue),
            float(body.family_history_heart),
            float(body.family_history_diabetes)
        ]

        print(f"[OK] Features: {len(data_values)}")

        # Redis cache check
        req_str = json.dumps(request_dict, sort_keys=True)
        req_hash = hashlib.sha256(req_str.encode()).hexdigest()
        cache_key = f"predict:{req_hash}"

        if REDIS_AVAILABLE and redis_client:
            cached = redis_client.get(cache_key)
            if cached:
                print("[OK] Cache hit")
                return json.loads(cached)

        # Run predictions using unified model
        all_preds = get_all_predictions(data_values)
        heart_risk = all_preds["heart_risk"]
        diabetes_risk = all_preds["diabetes_risk"]
        obesity_score = all_preds["obesity_risk"]

        # Calculate BMI
        height_m = body.height_cm / 100.0
        bmi = body.weight_kg / (height_m * height_m) if height_m > 0 else 0
        bmi = round(bmi, 1)

        if bmi < 18.5:
            bmi_category = "Underweight"
        elif bmi < 25.0:
            bmi_category = "Normal"
        elif bmi < 30.0:
            bmi_category = "Overweight"
        elif bmi < 35.0:
            bmi_category = "Obese Class I"
        elif bmi < 40.0:
            bmi_category = "Obese Class II"
        else:
            bmi_category = "Obese Class III"

        # Calculate WHtR
        whtr = body.waist_cm / body.height_cm if body.height_cm > 0 else 0
        whtr = round(whtr, 3)

        if whtr < 0.4:
            whtr_category = "Underweight Risk"
        elif whtr < 0.5:
            whtr_category = "Healthy"
        elif whtr < 0.6:
            whtr_category = "Overweight Risk"
        else:
            whtr_category = "High Obesity Risk"

        heart_category = "High" if heart_risk > 60 else "Moderate" if heart_risk > 30 else "Low"
        diabetes_category = "High" if diabetes_risk > 60 else "Moderate" if diabetes_risk > 30 else "Low"
        obesity_category = "High" if obesity_score > 60 else "Moderate" if obesity_score > 30 else "Low"

        result = {
            "heart_risk_percent": heart_risk,
            "heart_risk_category": heart_category,
            "heart_top_factors": [
                {"factor": "smoking_status", "contribution_percent": 20.5, "label": "Smoking Status"},
                {"factor": "physical_activity_level", "contribution_percent": 15.3, "label": "Physical Activity"},
                {"factor": "stress_level", "contribution_percent": 12.1, "label": "Stress Level"}
            ],
            "diabetes_risk_percent": diabetes_risk,
            "diabetes_risk_category": diabetes_category,
            "diabetes_top_factors": [
                {"factor": "family_history_diabetes", "contribution_percent": 18.2, "label": "Family History"},
                {"factor": "sugar_intake_level", "contribution_percent": 14.5, "label": "Sugar Intake"},
                {"factor": "physical_activity_level", "contribution_percent": 10.3, "label": "Physical Activity"}
            ],
            "obesity_risk_percent": obesity_score,
            "obesity_risk_category": obesity_category,
            "obesity_bmi": bmi,
            "obesity_bmi_category": bmi_category,
            "obesity_whtr": whtr,
            "obesity_whtr_category": whtr_category,
            "obesity_top_factors": [
                {"factor": "weight_kg", "contribution_percent": 40.0, "label": "Body Weight"},
                {"factor": "waist_cm", "contribution_percent": 25.0, "label": "Waist Circumference"},
                {"factor": "fried_food_consumption", "contribution_percent": 15.0, "label": "Junk Food Consumption"}
            ]
        }

        # Cache result
        if REDIS_AVAILABLE and redis_client:
            redis_client.setex(cache_key, 3600, json.dumps(result))

        # Save to Firestore
        uid = verify_token(request)
        if FIREBASE_AVAILABLE and db_firestore and uid:
            try:
                db_firestore.collection("predictions").add({
                    "userId": uid,
                    "results": result,
                    "inputs": request_dict,
                    "timestamp": firestore.SERVER_TIMESTAMP
                })
            except Exception as fe:
                print(f"Firestore error: {fe}")

        return result

    except Exception as e:
        print("[X] PREDICT ERROR:", str(e))
        print(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

# ── Diet Endpoint ──
@app.post("/diet")
async def diet(request: Request):
    try:
        body = await request.json()
        heart_risk = float(body.get("heart_risk", 0))
        diabetes_risk = float(body.get("diabetes_risk", 0))
        obesity_risk = float(body.get("obesity_risk", 0))
        medications = body.get("medications", [])

        plan = generate_diet_plan(heart_risk, diabetes_risk, obesity_risk, medications)
        return plan

    except Exception as e:
        print("[X] DIET ERROR:", str(e))
        raise HTTPException(status_code=500, detail=str(e))

# ── Secure Send Alert Endpoint ──
@app.post("/send-alert", response_model=AlertResponse)
@limiter.limit("5/minute", key_func=get_user_rate_limit_key)
async def send_alert(request: Request, body: AlertRequest):
    try:
        uid = verify_token(request)
        if not uid:
            raise HTTPException(status_code=401, detail="Unauthorized: Valid authentication required")

        # Threshold check: only alert if at least one risk is >= 70
        if not should_send_alert(body.heart_risk, body.diabetes_risk, body.obesity_risk):
            return AlertResponse(
                sent=False,
                sent_count=0,
                recipient_count=0,
                message="Risk scores are below high-risk threshold (70%). No alert required."
            )

        # Retrieve registered emergency contacts and profile name from Firestore
        authorized_contacts = []
        user_name = "User"

        if FIREBASE_AVAILABLE and db_firestore:
            try:
                # Retrieve user's verified profile name
                user_doc = db_firestore.collection("users").document(uid).get()
                if user_doc.exists:
                    user_data = user_doc.to_dict()
                    user_name = user_data.get("name") or user_data.get("displayName") or "User"

                # Retrieve registered family contacts
                contacts_stream = db_firestore.collection("users").document(uid).collection("familyAlerts").stream()
                for doc in contacts_stream:
                    cdata = doc.to_dict()
                    c_email = cdata.get("email", "").strip().lower()
                    if c_email and "@" in c_email and "." in c_email:
                        authorized_contacts.append({
                            "name": cdata.get("name", "Family Member"),
                            "email": c_email
                        })
            except Exception as fe:
                print(f"[!] Firestore contact lookup error: {fe}")

        # Fallback to sanitized client user_name if not in Firestore
        if user_name == "User" and body.user_name:
            user_name = str(body.user_name).strip()[:50]

        # Deduplicate and cap contacts at 5
        seen = set()
        clean_contacts = []
        for c in authorized_contacts:
            if c["email"] not in seen:
                seen.add(c["email"])
                clean_contacts.append(c)
            if len(clean_contacts) >= 5:
                break

        if not clean_contacts:
            return AlertResponse(
                sent=False,
                sent_count=0,
                recipient_count=0,
                message="No registered family contacts found in your profile. Please add contacts in Dashboard."
            )

        # Offload synchronous SMTP dispatch to thread pool to avoid blocking the async event loop
        result = await asyncio.to_thread(
            send_family_alerts,
            user_name=user_name,
            family_emails=clean_contacts,
            heart_risk=body.heart_risk,
            diabetes_risk=body.diabetes_risk,
            obesity_risk=body.obesity_risk
        )

        sent_count = len(result.get("sent_to", []))
        is_sent = result.get("sent", False) and sent_count > 0

        return AlertResponse(
            sent=is_sent,
            sent_count=sent_count,
            recipient_count=len(clean_contacts),
            message=f"Alerts sent to {sent_count} of {len(clean_contacts)} registered contacts" if is_sent else result.get("reason", "Failed to send alerts")
        )

    except HTTPException:
        raise
    except Exception as e:
        print("[X] ALERT ERROR:", str(e))
        raise HTTPException(status_code=500, detail="Internal server error during alert dispatch")
