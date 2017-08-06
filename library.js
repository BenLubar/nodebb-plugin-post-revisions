var db = module.parent.require("./database");
var winston = module.parent.require("winston");
var async = module.parent.require("async");
var privileges = module.parent.require("./privileges");
var User = module.parent.require("./user");
var Posts = module.parent.require("./posts");
var Topics = module.parent.require("./topics");
var SocketPlugins = require.main.require("./src/socket.io/plugins");

function isEditHistoryPublic(uid, callback) {
	if (!uid) {
		return callback(null, false);
	}

	User.getSettings(uid, function(err, settings) {
		if (err || !settings) {
			return callback(err, false);
		}

		var visible = parseInt(settings.postEditHistoryVisible, 10) === 1;

		callback(null, visible);
	});
}

function getPostEditHistory(pid, callback) {
	function convert(history, next) {
		var revisions = [];
		Object.keys(history).forEach(function(k) {
			if (parseInt(k, 10) > 0) {
				revisions.push(JSON.parse(history[k]));
			}
		});
		revisions.sort(function(a, b) {
			return b.ts - a.ts;
		});
		next(null, revisions);
	}

	db.getObject("pid:" + pid + ":postRevisions", function(err, history) {
		if (err) {
			return callback(err);
		}

		if (history) {
			return convert(history, callback);
		}

		convertPostEditHistory(pid, function(err, history) {
			if (err) {
				return callback(err);
			}

			convert(history, callback);
		});
	});
}

function convertPostEditHistory(pid, callback) {
	var _history;
	async.waterfall([
		function(next) {
			db.getSortedSetRevRangeWithScores("pid:" + pid + ":revisions", 0, -1, next);
		},
		function(revisions, next) {
			_history = {v: 1};
			revisions.forEach(function(rev) {
				var post = JSON.parse(rev.value);
				_history[String(rev.score)] = JSON.stringify({
					ts: rev.score,
					topic: null,
					post: post,
					mode: "edit",
					uid: post.editor
				});
			});
			db.setObject("pid:" + pid + ":postRevisions", _history, function(err) {
				next(err);
			});
		},
		function(next) {
			db.delete("pid:" + pid + ":revisions", function(err) {
				next(err, _history);
			});
		},
	], callback);
}

SocketPlugins.postRevisions = {
	"get": function(socket, data, callback) {
		var pid = parseInt(data.pid, 10);
		if (pid <= 0) {
			return callback(new Error("[[error:invalid-data]]"));
		}

		var _history;

		async.waterfall([
			function(next) {
				async.parallel({
					"isSelfOrPublic": function(next) {
						async.waterfall([
							function(next) {
								Posts.getPostField(pid, "uid", next);
							},
							function(uid, next) {
								if (uid && socket.uid === parseInt(uid, 10)) {
									return next(null, true);
								}

								isEditHistoryPublic(uid, next);
							}
						], next);
					},
					"isMod": function(next) {
						async.waterfall([
							function(next) {
								Posts.getCidByPid(pid, next);
							},
							function(cid, next) {
								privileges.categories.isAdminOrMod(cid, socket.uid, next);
							}
						], next);
					}
				}, next);
			},
			function(allowed, next) {
				next(!allowed.isSelfOrPublic && !allowed.isMod ?new Error("[[error:not-allowed]]") : null);
			},
			function(next) {
				async.parallel({
					"history": function(next) {
						getPostEditHistory(pid, next);
					},
					"currentPost": function(next) {
						Posts.getPostData(pid, next);
					}
				}, next);
			},
			function(revisions, next) {
				Topics.getTopicData(revisions.currentPost.tid, function(err, topic) {
					revisions.currentTopic = topic;
					next(err, revisions);
				});
			},
			function(revisions, next) {
				var history = [{
					ts: null,
					topic: revisions.currentTopic,
					post: revisions.currentPost,
					mode: "current",
					uid: null
				}].concat(revisions.history);
				var oldest = history[history.length - 1];
				if (oldest.post && oldest.post.edited) {
					history.push({
						ts: oldest.post.edited,
						topic: null,
						post: null,
						mode: "unknown",
						uid: oldest.post.editor
					});
				}
				next(null, history);
			},
			function(history, next) {
				_history = history;
				Posts.getUserInfoForPosts(history.map(function(rev) {
					return rev.uid;
				}), socket.uid, next);
			},
			function(users, next) {
				next(null, _history.map(function(rev, i) {
					rev.topic = rev.topic ? {
						title: rev.topic.title
					} : null;
					rev.post = rev.post ? {
						content: rev.post.content
					} : null;
					rev.user = users[i];
					return rev;
				}));
			}
		], callback);
	},
	"purge": function(socket, data, callback) {
		var pid = parseInt(data.pid, 10);
		if (pid <= 0) {
			return callback(new Error("[[error:invalid-data]]"));
		}
		var ts = parseInt(data.ts, 10);

		privileges.posts.canPurge(pid, socket.uid, function(err, canPurge) {
			if (err) {
				return callback(err);
			}

			if (!canPurge) {
				return callback(new Error("[[error:not-allowed]]"));
			}

			db.deleteObjectField("pid:" + pid + ":postRevisions", String(ts), callback);
		});
	}
};

module.exports = {
	"postsModifyUserInfo": function(data, callback) {
		User.getSettings(data.uid, function(err, settings) {
			if (err) {
				return callback(err);
			}

			data.editHistoryVisible = parseInt(settings.postEditHistoryVisible, 10) === 1;

			callback(null, data);
		});
	},
	"postEdit": function(data, callback) {
		var _postData;
		async.waterfall([
			function(next) {
				// make sure the edit history is in the current data format
				getPostEditHistory(data.post.pid, next);
			},
			function(history, next) {
				Posts.getPostData(data.post.pid, next);
			},
			function(postData, next) {
				_postData = postData;
				Topics.getTopicData(postData.tid, next);
			},
			function(topicData, next) {
				var payload = {
					ts: Date.now(),
					topic: topicData,
					post: _postData,
					mode: "edit",
					uid: data.uid
				};

				db.setObjectField("pid:" + data.post.pid + ":postRevisions", String(payload.ts), JSON.stringify(payload), next);
			},
			function(next) {
				data.post.revisionCount = parseInt(data.post.revisionCount || '0', 10) + 1;
				next(null, data);
			}
		], callback);
	},
	"postPurge": function(data) {
		db.deleteAll(["pid:" + data.post.pid + ":revisions", "pid:" + data.post.pid + ":postRevisions"], function(err) {
			if (err) {
				winston.error("[plugin/post-revisions] Error purging all post revisions for post " + data.post.pid + ": " + err);
			}
		});
	},
	"userSaveSettings": function(data) {
		db.setObjectField("user:" + data.uid + ":settings", "postEditHistoryVisible", parseInt(data.settings.postEditHistoryVisible, 10) ? "1" : "0", function(err) {
			if (err) {
				winston.error("[plugin/post-revisions] failed to save preference for user " + data.uid + ": " + err);
			}
		});
	},
	"userCustomSettings": function(data, callback) {
		User.getSettings(data.uid, function(err, settings) {
			if (err) {
				return callback(err);
			}

			var checked = parseInt(settings.postEditHistoryVisible, 10) === 1 ? ' checked' : '';

			data.customSettings.push({
				"title": "Post Revisions",
				"content": "<div class='checkbox'><label><input type='checkbox' data-property='postEditHistoryVisible'" + checked + "> <strong>Allow everyone to view old versions of my posts</strong></label></div><p class='help-block'>Applies retroactively. Staff can always see your post edit history. Contact a moderator or administrator if you need to purge a revision of a post.</p>"
			});

			callback(null, data);
		});
	}
};
