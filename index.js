console.log("be patient...");

const fs = require("fs").promises;
const path = require("path");
const inquirer = require("inquirer");
const { spawn } = require("child_process");
const { google } = require("googleapis");
const creds = require("./credentials.json");
const color = (text, code) => `\x1b[${code}m${text}\x1b[0m`;
const open = (what) => spawn("xdg-open", [what], { detatched: true }).unref();

const spinChars = "⣾⣽⣻⢿⡿⣟⣯⣷";
const SCOPES = [
	"https://www.googleapis.com/auth/classroom.courses.readonly",
	"https://www.googleapis.com/auth/classroom.coursework.me",
	"https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
	"https://www.googleapis.com/auth/classroom.announcements.readonly",
	"https://www.googleapis.com/auth/drive",
];

async function getNewToken(oAuth2Client, tokenPath) {
	const authUrl = oAuth2Client.generateAuthUrl({
		access_type: 'offline',
		scope: SCOPES,
	});
	console.log('Authorize this app by visiting this url:', authUrl);
	const res = await inquirer.prompt([{
		name: "code",
		message: "Enter code here",
	}]);
	const { tokens } = await oAuth2Client.getToken(res.code.trim());
	oAuth2Client.setCredentials(tokens);
	await fs.writeFile(tokenPath, JSON.stringify(tokens))
	console.log("Token stored to", tokenPath);
}

class CLI {
	constructor() {
		this.classroom = null;
		this.cache = new Map();
	}

	async login(tokenPath) {
		const { client_secret, client_id, redirect_uris } = creds.installed;
		const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
		try {
			const token = await fs.readFile(tokenPath);
			oAuth2Client.setCredentials(JSON.parse(token));
		} catch {
			await getNewToken(oAuth2Client, tokenPath);
		}
		this.auth = oAuth2Client;
		this.drive = google.drive({ version: "v3", auth: oAuth2Client })
		this.classroom = google.classroom({ version: 'v1', auth: oAuth2Client });
	}

	async listClasses() {
		if(this.cache.has("classrooms")) return this.cache.get("classrooms");
		const res = await this.classroom.courses.list({ pageSize: 50 });
		this.cache.set("classrooms", res.data.courses);
		return res.data.courses;
	}

	async listWork(courseId) {
		const work = await this.classroom.courses.courseWork.list({ courseId, pageSize: 50 });
		return work.data.courseWork;
	}

	async listItems(courseId) {
		const peek= (arr) => arr[arr.length - 1];
		const fetch = (which, pageSize) => this.classroom.courses[which].list({ courseId, pageSize });
		const grab = async (which, pageSize) => (await fetch(which, pageSize)).data[which] || [];
		const time = item => Date.parse(item.creationTime);

		const work = await grab("courseWork", 50);
		const announces = await grab("announcements", 20);
		return work.concat(announces).sort((a, b) => time(a) > time(b) ? -1 : 1);
	}
}

async function main() {
	const cli = new CLI();
	await cli.login(path.join(__dirname, "token.json"));
	const spinLogin = wait("logging in");
	const courses = await cli.listClasses();
	spinLogin();
	while(true) {
		const prompt = await inquirer.prompt([{
			name: "course",
			message: "which one",
			type: "list",
			choices: [
				{ name: "exit", value: null },
				new inquirer.Separator(),
				...courses.map(i => ({ name: i.name, value: i })),
			],
			loop: false,
		}]);
		if(!prompt.course) break;
		await course(cli, prompt.course);
	}
	console.log("goodbye");
}

async function course(cli, room) {
	console.log(room.descriptionHeading);
	const spinCourseItems = wait("loading");
	const list = await cli.listItems(room.id);
	spinCourseItems();
	while(true) {
		const which = await inquirer.prompt([{
			name: "work",
			message: "which one",
			type: "list",
			loop: false,
			choices: [
				"back",
				new inquirer.Separator(),
				...list.map(i => ({
					name: i.title || i.text.slice(0, 40) + "...",
					value: i,
				})),
			],
		}]);
		if(which.work === "back") break;
		if(which.work.title) {
			await coursework(cli, which.work);
		} else {
			await announcement(cli, which.work);
		}
	}
}

async function coursework(cli, work) {
	const due = work.dueDate;
	console.log(color(work.title, 1));
	console.log(`due on ${color(`${due.month}/${due.day}/${due.year}`, 33)}`);
	console.log(`worth ${color(work.maxPoints + " points", 36)}`);
	if(work.description) console.log(format(work.description));
	console.log(color(work.alternateLink, 90));
	console.log("\n");
	await attachments(cli, work);
}

async function announcement(cli, announcement) {
	console.log(format(announcement.text));
	console.log(color(announcement.alternateLink, 90));
	console.log("\n");
	await attachments(cli, announcement);
}

async function attachments(cli, item) {
	const choice = (type, name, value) => ({ name, value: { name, type, value } });
	const choices = ["back"];
	if(item.materials) {
		choices.push(new inquirer.Separator());
		for(let i of item.materials) {
			if(i.driveFile) {
				const file = i.driveFile.driveFile;
				choices.push(choice("file", file.title, file.id));
			} else if(i.youtubeVideo) {
				choices.push(choice("video", i.youtubeVideo.title, i.youtubeVideo.id));
			} else if(i.link) {
				choices.push(choice("url", i.link.title, i.link.url));
			}
		}
	}

	while(true) {
		const result = (await inquirer.prompt([{
			name: "now what",
			type: "list",
			choices,
		}]))["now what"];
		switch(result.type) {
			case "file": await downloadGDrive(cli.drive, result.value, result.name); continue;
			case "video": await ytdl(result.value); continue;
			case "url": await links(result.value); continue;
			// case "url": await open(result.value); continue;
			default: return;
		}
	}
}

function format(str) {
	const chunks = [""];
	for(let i of str) {
		if(i === "\n") {
			chunks.push("");
		} else if(chunks[chunks.length - 1].length > 60 && /\s/.test(i)) {
			chunks.push("");
		} else {
			chunks[chunks.length - 1] += i;
		}
	}
	return chunks.map(i => color("=> ", 90) + i).join("\n");
}

async function ytdl(id) {
	const ytdl = spawn("youtube-dl", ["-f", "best", "-4", id], { stdio: "inherit" });
	await new Promise(res => ytdl.on("close", res));
	const mpv = spawn("sh", ["-c", `mpv *${id}*`]);
	mpv.unref();
}

function links(url) {
	const links = spawn("links", [url], { stdio: "inherit" });
	return new Promise(res => links.on("close", res));
}

const types = new Map();
types.set("application/vnd.google-apps.document", ["application/rtf", ".rtf"]);
types.set("application/vnd.google-apps.spreadsheet", ["text/csv", ".ods"]);
types.set("application/vnd.google-apps.presentation", ["application/vnd.oasis.opendocument.presentation", ".odp"]);
types.set("application/vnd.google-apps.drawing", ["image/png", ".png"]);

async function downloadGDrive(drive, id, where) {
	const loader = wait("downloading...");
	const [req, ext] = await fetch(id);
	const dest = await fs.open(where + ext, "w");
	dest.write(req.data);
	await dest.close();
	open(where + ext);
	loader();
	console.log("done!");

	async function fetch(fileId) {
		const about = await drive.files.get({ fileId });
		if(types.has(about.data.mimeType)) {
			const [mimeType, ext] = types.get(about.data.mimeType);
			return [await drive.files.export({ fileId, mimeType }), ext];
		} else {
			return [await drive.files.get({ fileId, alt: "media" }), ""];
		}
	}
}

function wait(text) {
	let i = 0;
	const next = () => spinChars[i++ % spinChars.length];
	const interval = setInterval(() => {
		process.stdout.write(`\r${next()} ${text}`);
	}, 100);
	return (success = true) => {
		clearInterval(interval);
		process.stdout.write(`\r${" ".repeat(text.length + 2)}\r`);
	}
}

main();
