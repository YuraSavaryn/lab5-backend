const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_CREDENTIALS_PATH);
const port = process.env.PORT || 5000;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split("Bearer ")[1];
    if (!token) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; 
        next();
    } catch (error) {
        console.error("Token verification error:", error);
        return res.status(401).json({ message: "Unauthorized" });
    }
};

app.listen(port, () => {
    console.log(`Server is running on port ${port}!`);
});

app.get("/api/protected", verifyToken, (req, res) => {
    res.json({ message: "You have accessed a protected route!", user: req.user });
});

app.get("/api/users", async (req, res) => {
    const snapshot = await db.collection("users").get();
    const users = [];
    snapshot.forEach(doc => {
        users.push({ id: doc.id, ...doc.data() });
    });
    res.json(users);
});

app.get("/api/ratings", async (req, res) => {
    try {
        const snapshot = await db.collection("users").get();
        const users = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
        }));

        // Сортування за totalScore у порядку спадання
        const sortedRatings = users.sort((a, b) => (b.rating?.totalScore || 0) - (a.rating?.totalScore || 0));

        res.json(sortedRatings);
    } catch (error) {
        console.error("Error fetching ratings:", error);
        res.status(500).json({ message: "Failed to fetch ratings", error: error.message });
    }
});

app.get("/api/hackathons", async (req, res) => {
    try {
        const snapshot = await db.collection("hackathons").get();
        const hackathons = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
        }));
        res.json(hackathons);
    } catch (error) {
        console.error("Error fetching hackathons:", error);
        res.status(500).json({ message: "Failed to fetch hackathons", error: error.message });
    }
});

app.get("/api/user-joined-hackathons/:userId", verifyToken, async (req, res) => {
    const { userId } = req.params;

    if (req.user.uid !== userId) {
        return res.status(403).json({ message: "Forbidden: You can only access your own data" });
    }

    try {
        const snapshot = await db
            .collection("users")
            .doc(userId)
            .collection("joinedHackathons")
            .get();

        const joinedHackathons = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
        }));

        res.json(joinedHackathons);
    } catch (error) {
        console.error("Error fetching joined hackathons:", error);
        res.status(500).json({ message: "Failed to fetch joined hackathons", error: error.message });
    }
});

app.post("/api/join-hackathon", verifyToken, async (req, res) => {
    const { hackathonId } = req.body;
    const userId = req.user.uid;

    if (!hackathonId) {
        return res.status(400).json({ message: "Missing hackathonId" });
    }

    const hackathonIdStr = String(hackathonId);
    if (!hackathonIdStr.trim()) {
        return res.status(400).json({ message: "Invalid hackathonId: must be a non-empty string" });
    }

    try {
        const hackathonRef = db.collection("hackathons").doc(hackathonIdStr);
        const hackathonSnap = await hackathonRef.get();

        if (!hackathonSnap.exists) {
            return res.status(404).json({ message: "Hackathon not found" });
        }

        const hackathonData = hackathonSnap.data();

        const userHackathonRef = db.collection("users").doc(userId).collection("joinedHackathons").doc(hackathonIdStr);
        const userHackathonSnap = await userHackathonRef.get();

        if (userHackathonSnap.exists) {
            return res.status(400).json({ message: "You have already joined this hackathon" });
        }

        await hackathonRef.update({
            participants: (hackathonData.participants || 0) + 1,
        });

        await userHackathonRef.set({
            joinedAt: new Date().toISOString(),
            hackathonId: hackathonIdStr,
        });

        // Визначаємо actions залежно від статусу хакатону
        let actions;
        switch (hackathonData.status) {
            case "active":
                actions = ["Редагувати", "Подати"];
                break;
            case "draft":
                actions = ["Переглянути", "Видалити"];
                break;
            case "completed":
                actions = ["Переглянути", "Поділитися"];
                break;
            default:
                actions = ["Редагувати", "Подати"];
        }

        const projectRef = db.collection("my_projects").doc(`${userId}_${hackathonIdStr}`);
        await projectRef.set({
            id: `${userId}_${hackathonIdStr}`,
            title: hackathonData.title,
            description: hackathonData.description,
            image: hackathonData.image || "default-image",
            status: "active",
            statusText: hackathonData.status === "completed" ? "Завершений" : "В процесі",
            hackathonId: hackathonIdStr,
            timeStatus: hackathonData.status === "completed" ? "Завершено" : hackathonData.timeLeft || "Скоро розпочнеться",
            progress: hackathonData.status === "completed" ? "100%" : "50%",
            progressText: hackathonData.status === "completed" ? "Завершено" : "У процесі",
            actions: actions, // Використовуємо визначені actions
            createdAt: new Date().toISOString(),
            userId: userId, // Додаємо userId для фільтрації
        });

        const userRef = db.collection("users").doc(userId);
        const userSnap = await userRef.get();
        const userData = userSnap.data();
        const currentParticipations = userData.rating?.participations || 0;

        await userRef.update({
            "rating.participations": currentParticipations + 1,
            "rating.lastUpdated": new Date().toISOString(),
        });

        res.status(200).json({
            message: "Successfully joined hackathon",
            participants: (hackathonData.participants || 0) + 1,
        });
    } catch (error) {
        console.error("Error joining hackathon:", error);
        res.status(500).json({ message: "Failed to join hackathon", error: error.message });
    }
});

app.post("/api/register", async (req, res) => {
    const { email, password, name, surname } = req.body;

    if (!email || !password || !name || !surname) {
        return res.status(400).json({ message: "Missing required fields" });
    }

    try {
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: `${name} ${surname}`
        });

        console.log('User created with UID:', userRecord.uid);

        const initials = `${name.charAt(0)}${surname.charAt(0)}`.toUpperCase();

        await db.collection("users").doc(userRecord.uid).set({
            uid: userRecord.uid,
            email: userRecord.email,
            name: name,
            surname: surname,
            createdAt: new Date().toISOString(),
            rating: {
                activity: 'inactive',
                lastUpdated: new Date().toISOString(),
                initials: initials,
                participations: 0,
                team: "C.C.P.C.",
                totalScore: 0,
                trend: {
                    direction: 'same',
                    value: 0
                },
                victories: 0
            }
        });

        console.log('User data successfully saved to Firestore for UID:', userRecord.uid);
        res.status(201).json({ message: "User registered successfully", uid: userRecord.uid });
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({ message: "Failed to register user", error: error.message });
    }
});

app.post("/api/update-project-status", verifyToken, async (req, res) => {
    const { projectId, newStatus } = req.body;
    const userId = req.user.uid;

    if (!projectId || !newStatus) {
        return res.status(400).json({ message: "Missing projectId or newStatus" });
    }

    if (!['active', 'draft', 'completed'].includes(newStatus)) {
        return res.status(400).json({ message: "Invalid newStatus value" });
    }

    try {
        const projectRef = db.collection("my_projects").doc(projectId);
        const projectSnap = await projectRef.get();

        if (!projectSnap.exists) {
            return res.status(404).json({ message: "Project not found" });
        }

        const projectData = projectSnap.data();
        if (projectData.userId !== userId) {
            return res.status(403).json({ message: "Forbidden: You can only update your own projects" });
        }

        let updateData;
        switch (newStatus) {
            case 'active':
                updateData = {
                    status: 'active',
                    statusText: 'В процесі',
                    progress: projectData.progress,
                    progressText: 'У процесі',
                    actions: ['Редагувати', 'Подати'],
                };
                break;
            case 'draft':
                updateData = {
                    status: 'draft',
                    statusText: 'Чернетка',
                    progress: projectData.progress,
                    progressText: 'У процесі',
                    actions: ['Переглянути', 'Видалити'],
                };
                break;
            case 'completed':
                updateData = {
                    status: 'completed',
                    statusText: 'Завершений',
                    progress: projectData.progress,
                    progressText: 'Завершено',
                    timeStatus: 'Завершено',
                    actions: ['Переглянути', 'Поділитися'],
                };
                break;
            default:
                return res.status(400).json({ message: "Invalid newStatus value" });
        }

        await projectRef.update(updateData);

        res.status(200).json({
            message: "Project status updated successfully",
            project: { id: projectId, ...projectData, ...updateData },
        });
    } catch (error) {
        console.error("Error updating project status:", error);
        res.status(500).json({ message: "Failed to update project status", error: error.message });
    }
});