$(window).on('action:topic.loaded', function(e, data) {
	modifyEditIcon(data, data.posts);
});

$(window).on('action:posts.loaded', function(e, data) {
	if (!ajaxify.data.tid) {
		return;
	}

	modifyEditIcon(ajaxify.data, data);
});

$(window).on('action:posts.edited', function(e, data) {
	if (!ajaxify.data.tid) {
		return;
	}

	modifyEditIcon(ajaxify.data, [data.post]);
});

function modifyEditIcon(topic, posts) {
	var isAdminOrMod = topic.privileges.isAdminOrMod;
	posts.forEach(function(post) {
		if (!post.editedISO) {
			return;
		}

		var canViewHistory = isAdminOrMod || (post.user && post.user.editHistoryVisible) || post.selfPost;
		var editIcon = $('[component="post"][data-pid="' + post.pid + '"] .edit-icon');
		var editHistoryButton = editIcon.wrap('<span class="post-edit-history-button">').parent();
		if (post.revisionCount) {
			editHistoryButton.append(' ' + post.revisionCount);
		}
		if (canViewHistory) {
			editHistoryButton.on('click', function() {
				socket.emit('plugins.postRevisions.get', {pid: post.pid}, function(err, data) {
					if (err) {
						return app.alertError(err);
					}

					var canPurge = isAdminOrMod || (topic.privileges['posts:purge'] && post.selfPost);

					var historyViewer = $('<div class="post-edit-history-viewer">');
					data.forEach(function(rev) {
						var entry = $('<div>').prependTo(historyViewer);
						var editor = $('<a>');
						if (rev.editor.uid) {
							editor.text(' ' + rev.editor.username);
							editor.attr('href', '/uid/' + rev.editor.uid);
							if (rev.editor.picture) {
								$('<img component="user/picture" class="user-img">').attr('data-uid', rev.editor.uid).attr('src', rev.editor.picture).prependTo(editor);
							} else {
								$('<div class="user-icon">').text(rev.editor['icon:text']).css('background-color', rev.editor['icon:bgColor']).prependTo(editor);
							}
						} else {
							editor.hide();
						}
						var timestamp = $('<span>');
						if (rev.timestamp === null) {
							timestamp.text('Current version');
						} else {
							timestamp.addClass('timeago').attr('title', new Date(rev.timestamp).toISOString());
						}
						var header = $('<header>').append(editor).append(timestamp);
						if (canPurge && rev.timestamp !== null && rev.content !== null) {
							header.prepend($('<span class="btn btn-xs btn-danger">').text('Purge Revision').on('click', function() {
								if (!confirm('Are you sure you want to purge this revision? This cannot be undone.')) {
									return;
								}

								socket.emit('plugins.postRevisions.purge', {pid: post.pid, ts: rev.timestamp}, function(err) {
									if (err) {
										return app.alertError(err);
									}

									entry.remove();
								});
							}));
						}
						entry.append(header);
						entry.append(rev.content === null ? $('<em>').text('No further history is available.') : $('<pre>').text(rev.content));
					});
					var historyBackground = $('<div class="post-edit-history-viewer-background">').on('click', function() {
						historyViewer.remove();
						historyBackground.remove();
					});
					$('body').append(historyBackground).append(historyViewer);
					historyViewer.find('.timeago').timeago();
					historyViewer.scrollLeft(Number.MAX_SAFE_INTEGER);
					historyViewer.scrollTop(Number.MAX_SAFE_INTEGER);
				});
			});
		} else {
			editHistoryButton.addClass('disabled');
		}
	});
}
